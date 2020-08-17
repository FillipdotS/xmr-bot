const config = require('./config');
const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
require('winston-mail').Mail;

//
// Logger setup
//

let emailSubject;
if (config.DEBUG) {
	emailSubject = "DEBUG | Level {{level}} - {{msg}}";
}
else {
	emailSubject = "Level {{level}} - {{msg}}";
}

const logger = winston.createLogger({
	level: config.logLevel,
	format: winston.format.combine(
		winston.format.timestamp({format: "MM-DD HH:mm:ss"}),
		winston.format.printf(info => `${info.timestamp} ${info.level}: ${info.message}`),
	),
	transports: [
		new winston.transports.DailyRotateFile({
			filename: 'xmrbot_info_%DATE%.log',
			dirname: 'logs',
			datePattern: 'YY-MM-DD',
			level: 'info',
		}),
		new winston.transports.DailyRotateFile({
			filename: 'xmrbot_errors_%DATE%.log',
			dirname: 'logs',
			datePattern: 'YY-MM-DD',
			level: 'warn',
		}),
		new winston.transports.Console({
			format: winston.format.combine(
				winston.format.colorize(),
				winston.format.timestamp({format: "HH:mm:ss"}),
				winston.format.printf(info => `${info.timestamp} ${info.level}: ${info.message}`),
			),
			timestamp: true,
		}),
		new winston.transports.Mail({
			to: "***@gmail.com",
			from: "***@gmail.com",
			host: "smtp.gmail.com",
			port: "465",
			username: config.email.username,
			password: config.email.pass,
			level: "error",
			ssl: true,
			subject: emailSubject,
			formatter: ({level, message, meta}) => {
				let s = "";
				s += 'Exact timestamp: ' + meta.timestamp + ' | Level of log: "' + level + '"\n\n';
				s += "Message is:\n" + message + "\n\n";
				s += "Meta is:\n";
				s += JSON.stringify(meta);
				return s;
			}
		}),
	],
});

module.exports = logger;