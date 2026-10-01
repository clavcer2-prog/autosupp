const fs = require('fs');
const path = require('path');

// Фоновые циклы библиотеки telegram (gramjs) — в частности приём апдейтов —
// иногда кидают TIMEOUT/сетевые ошибки как необработанный reject, который
// не относится к нашему коду и который мы никак не await'им. Начиная с
// Node 15 необработанный rejection по умолчанию убивает весь процесс —
// то есть аккаунт может «зависнуть» и перестать отвечать (в т.ч. не пришедший
// код при /login на самом деле означает, что бот уже упал сразу после
// успешной отправки кода). Логируем и продолжаем работу вместо падения.
process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err);
});

const config = require('./config');
const users = require('./users');
const { SessionManager } = require('./session');
const setupBot = require('./bot');

// --- одноразовый перенос данных из старой однопользовательской версии -------
// Раньше сессия, чаты и каналы лежали в общем config.json, поэтому любой
// зарегистрированный пользователь видел данные владельца. Переносим их
// владельцу, а всем остальным заводим ПУСТЫЕ карточки — каждый логинится сам.

function migrate() {
  if (config.data.migratedToMultiuser) return;

  const legacy = config.data;
  const ownerId = legacy.ownerId;

  if (ownerId) {
    const owner = users.ensure(ownerId, { key: 'owner' });
    if (!owner.session && legacy.session) owner.session = legacy.session;
    if (!owner.phone && legacy.phone) owner.phone = legacy.phone;
    if (!owner.chats.length && Array.isArray(legacy.chats)) owner.chats = [...legacy.chats];
    if (!owner.channels.length && Array.isArray(legacy.channels)) owner.channels = [...legacy.channels];
    if (!owner.folders.length && Array.isArray(legacy.folders)) owner.folders = [...legacy.folders];
    if (!owner.logsChannel && legacy.logsChannel) owner.logsChannel = legacy.logsChannel;
    if (legacy.autopost && typeof legacy.autopost === 'object') owner.autopost = legacy.autopost;
    users.save();
    console.log('migrate: данные владельца перенесены в users.json');
  } else if (legacy.session) {
    console.log('migrate: в конфиге есть сессия, но ownerId не задан — сессия не перенесена');
  }

  // старые зарегистрированные пользователи: заводим пустые карточки
  for (const dir of [config.VOLUME_DIR, __dirname]) {
    const storeFile = path.join(dir, 'store.json');
    if (!fs.existsSync(storeFile)) continue;
    try {
      const old = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
      const oldUsers = (old && old.users) || {};
      for (const [id, rec] of Object.entries(oldUsers)) {
        if (users.has(id)) continue;
        users.create(id, { username: rec.username || null, key: rec.key || null, registeredAt: rec.registeredAt || Date.now() });
        console.log('migrate: перенесён пользователь', id, '(без данных — залогинится сам)');
      }
      // старые ключи регистрации
      for (const [key, rec] of Object.entries((old && old.pendingKeys) || {})) {
        if (!config.data.pendingKeys[key]) config.data.pendingKeys[key] = rec;
      }
    } catch (e) {
      console.log('migrate: store.json прочитать не вышло:', e.message);
    }
  }

  // чистим общие поля, чтобы никто больше не наследовал чужие данные
  delete config.data.session;
  delete config.data.phone;
  delete config.data.chats;
  delete config.data.channels;
  delete config.data.folders;
  delete config.data.autopost;
  delete config.data.logsChannel;
  config.data.migratedToMultiuser = true;
  config.save();
}

async function main() {
  if (!config.data.botToken) {
    console.error('Не задан botToken (config.json или переменная BOT_TOKEN)');
    process.exit(1);
  }
  if (!config.data.apiId || !config.data.apiHash) {
    console.error('Не заданы apiId/apiHash (config.json или переменные API_ID/API_HASH)');
    process.exit(1);
  }

  migrate();

  const sessions = new SessionManager(config, users);
  const bot = setupBot(config, users, sessions);

  // поднимаем сессии всех, кто уже авторизован
  await sessions.startAll();

  // общий тик автопоста для всех пользователей
  setInterval(() => sessions.tickAll(), 30 * 1000);

  console.log(`VZ bot запущен. Пользователей: ${users.all().length}`);

  const shutdown = async (signal) => {
    console.log('Останавливаюсь:', signal);
    try { bot.stop(signal); } catch {}
    for (const s of sessions.map.values()) {
      try { await s.stop(); } catch {}
    }
    process.exit(0);
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
