// Modul logger untuk aplikasi
const winston = require('winston');
const path = require('path');
const fs = require('fs');

// Buat direktori logs jika belum ada
const logsDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
}

// Format untuk log
const logFormat = winston.format.printf(({ level, message, timestamp }) => {
    return `${timestamp} ${level}: ${message}`;
});

function parsePositiveInt(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const fileMaxSize = parsePositiveInt(process.env.LOG_MAX_SIZE_BYTES, 10 * 1024 * 1024);
const fileMaxFiles = parsePositiveInt(process.env.LOG_MAX_FILES, 10);

function rotatingFileTransport(filename, options = {}) {
    return new winston.transports.File({
        filename: path.join(logsDir, filename),
        maxsize: fileMaxSize,
        maxFiles: fileMaxFiles,
        tailable: true,
        ...options
    });
}

// Konfigurasi logger
const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
        winston.format.timestamp({
            format: 'YYYY-MM-DD HH:mm:ss'
        }),
        logFormat
    ),
    transports: [
        // Log ke file
        rotatingFileTransport('error.log', { level: 'error' }),
        rotatingFileTransport('combined.log'),
        // Log ke console
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.timestamp({
                    format: 'YYYY-MM-DD HH:mm:ss'
                }),
                logFormat
            )
        })
    ],
    exceptionHandlers: [
        rotatingFileTransport('exceptions.log'),
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.timestamp({
                    format: 'YYYY-MM-DD HH:mm:ss'
                }),
                logFormat
            )
        })
    ]
});

module.exports = { logger };
