'use strict'
const Database = require('better-sqlite3')
const path = require('path')
const fs = require('fs')

const DB_PATH = path.join(__dirname, '../../data/argus.db')
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true })

const db = new Database(DB_PATH, {
  verbose: process.env.DB_VERBOSE === '1' ? console.log : undefined,
})

// WAL mode: safe concurrent reads while writes happen
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')
db.pragma('synchronous = NORMAL')

module.exports = db
