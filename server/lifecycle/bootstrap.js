const fs = require('fs');

const cron = require('../configuration/cron');

const {
  tmpDir
} = require('../../internal/utils');

const RUN_ON_BOOT = true

module.exports = async ({ strapi }) => {
  if (!fs.existsSync(tmpDir())) {
    fs.mkdirSync(tmpDir());
  }

  if (RUN_ON_BOOT === true) {
    const backupConfig = strapi.config.get('plugin.backup');
    const backupService = strapi.plugin('backup').service('backup');
    const backupLogService = strapi.plugin('backup').service('log');

    const date = new Date();

    if (!backupConfig.disableUploadsBackup) {
      const backupFilename = typeof backupConfig.customUploadsBackupFilename === 'function'
        ? backupConfig.customUploadsBackupFilename({ strapi })
        : createBackupFilenameFromPrefixAndDate('uploads', date)
        ;

      backupService.backupFile({
        filePath: `${strapi.dirs.public ? strapi.dirs.public : strapi.dirs.static.public}/uploads`,
        backupFilename,
      })
        .then(() => {
          backupLogService.info(`backup: ${backupFilename}`);
        })
        .catch(function (error) {
          backupLogService.error(`backup: ${backupFilename} failed`);
          backupConfig.errorHandler(error, strapi);
        });
    }

    if (!backupConfig.disableDatabaseBackup) {
      const databaseBackupFilename = typeof backupConfig.customDatabaseBackupFilename === 'function'
        ? backupConfig.customDatabaseBackupFilename({ strapi })
        : createBackupFilenameFromPrefixAndDate('database', date)
        ;

      backupService.backupDatabase({
        backupFilename: databaseBackupFilename
      })
        .then(() => {
          backupLogService.info(`backup: ${databaseBackupFilename}`);
        })
        .catch(function (error) {
          backupLogService.error(`backup: ${databaseBackupFilename} failed`);
          backupConfig.errorHandler(error, strapi);
        });
    }
  }

  strapi.cron.add(
    cron({ strapi })
  );

  strapi.plugin('backup')
    .service('log')
    .info('bootstrap');
};
