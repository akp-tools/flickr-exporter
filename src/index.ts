import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as https from 'https';
import * as path from 'path';

import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import * as Flickr from 'flickr-sdk';
import * as GhostAdminAPI from '@tryghost/admin-api';
import axios from 'axios';

// Set up Flickr SDK
const flickr = new Flickr(functions.config().flickr.key);

// Set up Firebase Admin SDK
admin.initializeApp(functions.config().firebase);

// Set up Ghost API
const ghost = new GhostAdminAPI({
  url: functions.config().ghost.url,
  key: functions.config().ghost.key,
  version: 'v5.41',
  // I really don't want to override makeRequest here, but the implementation within @tryghost/admin-api doesn't
  // set maxBodyLength to Infinity, and that's required because images are big.
  makeRequest: ({ url, method, data, params = {}, headers = {} }: any) => {
    return axios({
      url,
      method,
      params,
      data,
      headers,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      paramsSerializer(parameters) {
        return Object.keys(parameters)
          .reduce((parts: string[], key) => {
            const val = encodeURIComponent(
              [].concat(parameters[key]).join(',')
            );
            return parts.concat(`${key}=${val}`);
          }, [])
          .join('&');
      },
    }).then((res) => {
      return res.data;
    });
  },
});

const last_check_ref = admin.database().ref('last_check_time');
const photo_status_ref = admin.database().ref('photo_status');

export const photoUploader = functions.pubsub
  .schedule('every 5 minutes')
  .onRun(async () => {
    const last_check_time = (await last_check_ref.get()).val();

    // next check time should be offset by -24 hours to be sure we don't accidentally miss images.
    // we store image upload status as well, so this should be fine.
    const next_check_time = Math.floor(
      new Date(new Date().getTime() - 24 * 60 * 60 * 1000).getTime() / 1000
    );

    console.log(
      `Fetching photos from Flickr posted since ${new Date(
        last_check_time * 1000
      ).toISOString()}.`
    );

    // get list of photos from Flickr
    const photos = await flickr.people
      .getPhotos({
        user_id: functions.config().flickr.userid,
        extras:
          'description,date_upload,original_format,geo,tags,o_dims,media,url_o',
        per_page: 500,
        content_type: 1,
        min_upload_date: last_check_time,
      })
      .then((res: Response) => res.body)
      .then((res: any) => res.photos.photo);

    console.log(`Fetched ${photos.length} new photos from Flickr.`);

    // for each photo, we'll download it, upload it to Ghost and create a new post
    for (const photo of photos) {
      const current_status = await (
        await photo_status_ref.child(photo.id).get()
      ).val();

      if (current_status && current_status.success) {
        console.log(`Skipping ${photo.id} (${photo.title}).`);
        continue;
      }

      const photoStatus = {
        id: photo.id,
        url_o: photo.url_o,
        title: photo.title,
        desc: photo.description._content,
        date: photo.dateupload,
        tags: photo.tags,
        success: true,
        error: null,
      };

      try {
        console.log(`Downloading ${photo.id} (${photo.title}) from Flickr...`);
        const filePath = await downloadImage(photo.url_o);

        console.log(`Uploading ${photo.id} (${photo.title}) to Ghost...`);
        const imageUpload = await ghost.images.upload({
          ref: filePath,
          file: path.resolve(filePath),
        });

        console.log(`Deleting ${photo.id} (${photo.title})...`);
        await fsPromises.unlink(filePath);

        // ensure all tags are created
        const tags = [...photo.tags.split(' '), 'flickr'].sort();
        const ghostTags = (await ghost.tags
          .browse({ limit: 10000 })
          .then((tags: any) => tags.map((t: any) => t.name))) as string[];

        for (const tag of tags) {
          if (!ghostTags.includes(tag)) {
            console.log(`Creating tag '${tag}'.`);
            await ghost.tags.add({ name: tag, slug: tag });
          }
        }

        // This seems very brittle and should probably be done in a better way.
        const published_at = new Date(photo.dateupload * 1000).toISOString();

        console.log(
          `Creating new post for ${photo.id} (${photo.title}) in Ghost...`
        );
        await ghost.posts.add(
          {
            title: photo.title,
            html: `<p>${photo.description._content}</p>`,
            status: 'published',
            tags,
            feature_image: imageUpload.url,
            published_at,
          },
          { source: 'html' }
        );
      } catch (e) {
        console.log('Error caught!');
        photoStatus.success = false;
        photoStatus.error = (e as any).message;
        console.error(e);
      }

      await photo_status_ref.child(photo.id).set(photoStatus);
    }

    await last_check_ref.set(next_check_time);
  });

const downloadImage = (url: string): Promise<string> => {
  return new Promise((resolve, reject) => {
    const destination = path.resolve(`/tmp/${path.basename(url)}`);
    const fileStream = fs.createWriteStream(destination);
    const httpRequest = https.get(url, (resp) => {
      resp.pipe(fileStream);
      fileStream.on('finish', () =>
        fileStream.close(() => resolve(destination))
      );
    });

    httpRequest.on('error', (err) => {
      fsPromises.unlink(destination).then(() => {
        reject(err.message);
      });
    });
  });
};
