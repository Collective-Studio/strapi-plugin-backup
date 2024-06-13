'use strict';

const fs = require("fs");

const StorageService = {
  AWS_S3: 'aws-s3',
  AZURE_BLOB_STORAGE: 'azure-blob-storage',
  GCS: 'gcs'
};

class AbstractStorage {

  /** @return {Promise} */
  async put(content, filename) {
    throw new Error('Method put not implemented');
  }

  /** @returns {Promise<{ name: string, date: Date }[]>}  */
  list() {
    throw new Error('Method list not implemented');
  }

  /** @return {Promise} */
  delete(filenames) {
    throw new Error('Method delete not implemented');
  }
}

class AwsS3 extends AbstractStorage {
  #s3;
  #bucket;

  constructor(
    {
      bucket,
      endpoint = undefined,
      key,
      region = undefined,
      secret,
    }
  ) {
    super();

    const AWS = require('aws-sdk');

    const awsConfig = {
      apiVersion: 'latest',
      accessKeyId: key,
      secretAccessKey: secret,
      // To-do: add this to confugurable options
      s3ForcePathStyle: true
    };

    if (region !== undefined) {
      awsConfig.region = region;
    }

    AWS.config.update(awsConfig);

    const s3Config = {};

    if (endpoint !== undefined) {
      s3Config.endpoint = endpoint;
    }

    this.#s3 = new AWS.S3(s3Config);
    this.#bucket = bucket;
  }

  async put(filePath, filename) {
    const S3 = this.#s3
    const Bucket = this.#bucket
    const Key = filename

    const stats = fs.statSync(filePath);
    const fileSize = stats.size;
    // console.log("File size in bytes", fileSize)

    const MAX_PARTS = 400
    let SIZE_FACTOR = 1
    let PART_SIZE = 5 * SIZE_FACTOR * 1024 * 1024;

    // Multipart uploads with default 5 MB per part.
    let numberOfPart = Math.ceil(fileSize / PART_SIZE);
    console.log("Original number of parts: ", numberOfPart)
    if (numberOfPart > MAX_PARTS) {
      SIZE_FACTOR = Math.ceil(numberOfPart / MAX_PARTS)
      PART_SIZE = PART_SIZE * SIZE_FACTOR
      numberOfPart = Math.ceil(numberOfPart / SIZE_FACTOR)
      console.log("New number of parts: ", numberOfPart, " with size factor: ", SIZE_FACTOR, " and part size: ", PART_SIZE)
    }
    const stream = fs.createReadStream(filePath, { highWaterMark: PART_SIZE })


    const multipartUpload = await S3.createMultipartUpload({
      Bucket, Key
    }).promise()

    const uploadId = multipartUpload.UploadId
    // console.log("uploadId", uploadId)
    if (!uploadId) {
      return new Error("Failed to create multipart upload")
    }

    const start = Date.now()
    // const uploadPromises: Promise<PromiseResult<AWS.S3.UploadPartOutput, AWS.AWSError>>[] = [];
    const etagArray = []
    let running = 0
    let finished = 0

    const NUMBER_OF_WORKERS = 16
    for await (const data of stream) {
      const tmpFinished = finished
      const tmpRunning = running
      running += 1

      // console.log("current worker: ", running, " running: ", tmpFinished + tmpRunning, " finished: ", tmpFinished)
      while (running >= NUMBER_OF_WORKERS) {
        // console.log("Waiting for 2.5s")
        await sleep(100);
      }

      // console.log("Creating part", tmpFinished + tmpRunning + 1, " with size: ", data.length)
      S3.uploadPart({ Bucket, Key, UploadId: uploadId, PartNumber: tmpFinished + tmpRunning + 1, Body: data }).on("success", (response) => {
        running -= 1
        finished += 1
        // console.log("Finished part", tmpFinished + tmpRunning + 1)
        const etag = response.data?.ETag
        if (etag) {
          etagArray.push({ ETag: etag, PartNumber: tmpFinished + tmpRunning + 1 })
        }
      }).send()

      await sleep(250)
    }

    while (finished < numberOfPart && etagArray.length < numberOfPart) {
      await sleep(100)
    }
    const end = Date.now()
    console.log("Time taken: ", end - start)
    // console.log("Finished all parts", etagArray)

    // const uploadResults = await Promise.all(uploadPromises);
    // console.log(uploadResults)


    const multipartComplete = await S3.completeMultipartUpload({
      Bucket,
      Key,
      UploadId: uploadId,
      MultipartUpload: {
        Parts: etagArray.sort((a, b) => {
          return a.PartNumber - b.PartNumber
        }).map((part) => ({
          ETag: part.ETag,
          PartNumber: part.PartNumber
        }))
      }
    }).promise()
    console.log(multipartComplete)
    if (multipartComplete.ETag) {
      return
    }
    return new Error("Failed to upload file")
  }

  list() {
    return new Promise(async (resolve, reject) => {
      try {
        resolve(this.tryToList());
      } catch (error) {
        reject(error);
      }
    });
  }

  async tryToList() {
    let backups = [];
    let params = {
      Bucket: this.#bucket,
      MaxKeys: 1000
    };

    do {
      let response = await this.#s3.listObjectsV2(params).promise();

      backups = backups.concat(
        response.Contents.map((content => ({
          name: content.Key,
          date: new Date(content.LastModified)
        })))
      );

      params.ContinuationToken = response.NextContinuationToken;

    } while (params.ContinuationToken);

    return backups;
  }

  delete(filenames) {
    return new Promise((resolve, reject) => {
      this.#s3.deleteObjects(
        {
          Bucket: this.#bucket,
          Delete: {
            Objects: filenames.map(filename => ({
              Key: filename
            }))
          }
        },
        function (error) {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        }
      );
    });
  }
}

const {
  BlobServiceClient,
  StorageSharedKeyCredential
} = require("@azure/storage-blob");

class AzureBlobStorage extends AbstractStorage {
  #containerClient;

  constructor(
    {
      accountName,
      accountKey,
      containerName
    }
  ) {
    super();

    this.#containerClient = new BlobServiceClient(
      `https://${accountName}.blob.core.windows.net`,
      new StorageSharedKeyCredential(accountName, accountKey)
    )
      .getContainerClient(containerName);
  }

  async put(content, filename) {
    return new Promise((resolve, reject) => {
      this.#containerClient
        .getBlockBlobClient(filename)
        .uploadStream(content)
        .then(resolve)
        .catch(reject);
    });
  }

  list() {
    return new Promise(async (resolve, reject) => {
      try {
        resolve(await this.tryToList());
      } catch (error) {
        reject(error);
      }
    });
  }

  async tryToList() {
    let archives = [];

    const blobs = await this.#containerClient
      .listBlobsFlat();

    for await (const blob of blobs) {
      archives.push({
        name: blob.name,
        date: new Date(blob.properties.lastModified)
      });
    }

    return archives;
  }

  async delete(filenames) {
    return new Promise((resolve, reject) => {
      filenames.forEach(async (filename) => {
        await this.#containerClient
          .getBlobClient(filename)
          .deleteIfExists()
          .catch(reject)
      });

      resolve();
    });
  }
}

const {
  Storage
} = require('@google-cloud/storage');

class GoogleCloudStorage extends AbstractStorage {
  #bucket;

  constructor(
    {
      keyFilename,
      bucketName
    }
  ) {
    super();

    this.#bucket = new Storage({ keyFilename }).bucket(bucketName);
  }

  put(content, filename) {
    return new Promise((resolve, reject) => {
      this.#bucket
        .upload(
          content.path,
          { destination: filename },
          function (error) {
            if (error) {
              reject(error);
              return;
            }

            resolve();
          }
        );
    });
  }

  list() {
    return new Promise(async (resolve, reject) => {
      try {
        resolve(this.tryToList());
      } catch (error) {
        reject(error);
      }
    });
  }

  async tryToList() {
    let backups = [];
    let query = {};

    do {
      let [files, nextQuery] = await this.#bucket.getFiles(query);

      backups = backups.concat(
        files.map((file => ({
          name: file.metadata.name,
          date: new Date(file.metadata.updated)
        })))
      );

      query = nextQuery;

    } while (query);

    return backups;
  }

  delete(filenames) {
    return new Promise((resolve, reject) => {
      for (const filename of filenames) {
        this.#bucket
          .file(filename)
          .delete((error) => {
            if (error) {
              reject(error);
            }
          });
      }

      resolve();
    });
  }
}

/** @returns { AbstractStorage } */
const createStorageServiceFromConfig = (
  {
    storageService,
    awsAccessKeyId,
    awsSecretAccessKey,
    awsRegion = undefined,
    awsS3Endpoint = undefined,
    azureStorageAccountName,
    azureStorageAccountKey,
    azureStorageContainerName,
    awsS3Bucket,
    gcsKeyFilename,
    gcsBucketName
  }
) => {
  switch (storageService) {
    case StorageService.AWS_S3:
      return new AwsS3({
        key: awsAccessKeyId,
        secret: awsSecretAccessKey,
        region: awsRegion,
        endpoint: awsS3Endpoint,
        bucket: awsS3Bucket
      });
    case StorageService.AZURE_BLOB_STORAGE:
      return new AzureBlobStorage({
        accountName: azureStorageAccountName,
        accountKey: azureStorageAccountKey,
        containerName: azureStorageContainerName
      });
    case StorageService.GCS:
      return new GoogleCloudStorage({
        keyFilename: gcsKeyFilename,
        bucketName: gcsBucketName
      });
  }

  throw new Error(
    `“${storageService}“ is not a valid strapi-plugin-backup config “storageService“ value.`
    + ` Available values are : ${Object.values(StorageService).join(', ')}.`
  );
};

module.exports = {
  createStorageServiceFromConfig,
  StorageService
};
