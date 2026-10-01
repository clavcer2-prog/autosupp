const fs = require('fs');
const path = require('path');

// Глобальный конфиг ПРИЛОЖЕНИЯ (общий для всех пользователей):
// apiId/apiHash, токен бота, id владельца и ключи регистрации.
// Личные данные каждого пользователя (сессия, чаты, каналы, автопост)
// лежат отдельно — см. users.js

const VOLUME_DIR = process.env.CONFIG_DIR || '/app/data';
const file = path.join(VOLUME_DIR, 'config.json');
const seedFile = path.join(__dirname, 'config.json');

const DEFAULTS = {
  apiId: null,
  apiHash: '',
  botToken: '',
  ownerId: null,
  // значения по умолчанию для НОВОГО пользователя
  defaultVotes: 21,
  confirmKeyword: 'сообщите',
  doneKeyword: 'тап сообщите',
  afterYouReply: 'тап, сообщите',
  answerGeneralOffers: false,
  pendingKeys: {},
  supportThreads: {} // messageId (в чате владельца) -> { userId, username, at } — для двусторонней техподдержки
};

let data = {};

try {
  if (!fs.existsSync(VOLUME_DIR)) fs.mkdirSync(VOLUME_DIR, { recursive: true });

  if (!fs.existsSync(file)) {
    if (fs.existsSync(seedFile)) fs.copyFileSync(seedFile, file);
    else fs.writeFileSync(file, JSON.stringify({}, null, 2));
  }

  data = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
} catch (e) {
  console.error('config.json не найден или битый:', e.message);
  data = {};
}

// дописываем недостающие поля один раз
let changed = false;
for (const [k, v] of Object.entries(DEFAULTS)) {
  if (data[k] === undefined) {
    data[k] = v;
    changed = true;
  }
}

// переменные окружения имеют приоритет (удобно для деплоя)
if (process.env.API_ID) data.apiId = Number(process.env.API_ID);
if (process.env.API_HASH) data.apiHash = process.env.API_HASH;
if (process.env.BOT_TOKEN) data.botToken = process.env.BOT_TOKEN;
if (process.env.OWNER_ID) data.ownerId = Number(process.env.OWNER_ID);

function save() {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('config save error:', e.message);
  }
}

if (changed) save();

console.log('config.js: файл', file, '| apiId =', data.apiId, '| ownerId =', data.ownerId);

module.exports = { data, save, file, VOLUME_DIR };
