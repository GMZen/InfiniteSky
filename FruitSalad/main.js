var winston = require('winston');

var config = {};

if (config.logFile) {
	winston.add(winston.transports.File, { filename: config.logFile })
}

// For information on Winston please see https://github.com/winstonjs/winston
winston.profile('Startup');
winston.info('Starting InfiniteSky', { datetime: new Date() });

//
// Configure CLI output on the default logger
//
winston.cli();



//
// Handle errors
//
// logger.on('error', function (err) { /* Do Something */ });



winston.profile('Startup');