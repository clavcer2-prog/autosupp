const { registerOfferCommands } = require('./offers');
const { Telegraf } = require('telegraf');
const { Api, utils } = require('telegram');
const { CustomFile } = require('telegram/client/uploads');
const https = require('https');
const crypto = require('crypto');
const parser = require('./parser');

// Одноразовый ключ вида "A1B2-C3D4"
function generateKey() {
  const raw = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
}

// Скачивает файл по URL в буфер (следует за редиректами, Telegram file-links их иногда отдают)
function fetchBuffer(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
        res.resume();
        return fetchBuffer(res.headers.location, redirectsLeft - 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`Не смог скачать файл (HTTP ${res.statusCode})`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(ctx) {
  return ctx.message.text.split(/[\s,;]+/).slice(1).filter(Boolean);
}

const MIN_INTERVAL_MIN = 10;
const MAX_INTERVAL_MIN = 30 * 24 * 60;

function parseInterval(str) {
  const m = String(str || '').trim().toLowerCase().replace(',', '.')
    .match(/^(\d+(?:\.\d+)?)\s*(м|мин\S*|m|min\S*|ч|час\S*|h|hr|hour\S*|д|дн\S*|день|d|day\S*)?$/);
  if (!m) return null;
  const unit = m[2] || 'м';
  let mult = 1;
  if (/^(ч|час|h)/.test(unit)) mult = 60;
  else if (/^(д|дн|день|d)/.test(unit)) mult = 1440;
  const minutes = Math.round(parseFloat(m[1]) * mult);
  return minutes > 0 ? minutes : null;
}

function fmtMinutes(total) {
  total = Math.max(0, Math.round(total));
  const d = Math.floor(total / 1440);
  const h = Math.floor((total % 1440) / 60);
  const m = total % 60;
  const parts = [];
  if (d) parts.push(`${d} д`);
  if (h) parts.push(`${h} ч`);
  if (m || !parts.length) parts.push(`${m} мин`);
  return parts.join(' ');
}

async function replyLong(ctx, text) {
  const MAX = 4000;
  let rest = text;
  while (rest.length > MAX) {
    let cut = rest.lastIndexOf('\n', MAX);
    if (cut <= 0) cut = MAX;
    await ctx.reply(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest) await ctx.reply(rest);
}

function helpText(isOwner) {
  return (
    'VZ бот. Каждый пользователь работает на своём аккаунте и со своими списками.\n\n' +
    (isOwner ? '👑 Владелец:\n/genkey — выдать ключ регистрации\n/users — список пользователей\n/revoke <id> — удалить пользователя\n/login_code — показать последние сообщения из служебного чата Telegram (777000, до 20 шт.) — на случай, если код всё же не переслался автоматически\n\n' : '') +
    '🔑 Аккаунт:\n' +
    '/login <номер> — вход в свой Telegram (например /login +79990000000)\n' +
    '/code <код> — код из Telegram\n' +
    '/password <пароль> — 2FA\n' +
    '/logout — выйти из аккаунта\n' +
    'ℹ️ Пока сессия активна, коды входа и другие сообщения от Telegram (777000) пересылаются сразу и автоматически — в лог-канал и в личку\n' +
    '/api <apiId> <apiHash> — свои api-ключи (необязательно)\n\n' +
    '📄 Договоры о ВЗ:\n' +
    '/deals_channel <ссылка|@юз|id> — выбрать канал для договоров\n' +
    '/deals_channel off — отключить\n' +
    '/deals_channel — показать текущий\n' +
    '/create_deals_channel <название> — создать канал под договоры\n\n' +
    '💬 Вз-чаты:\n' +
    '/add_chat <ссылка> [...] — добавить\n' +
    '/add_folder <t.me/addlist/...> — добавить чаты из папки\n' +
    '/folders, /del_folder <номер|ссылка>\n' +
    '/chats, /del_chat <ссылка> [...], /del_all_chats\n' +
    '/fix_chats — починить старые записи чатов, если рассылка не уходит\n\n' +
    '📢 Каналы для тапов:\n' +
    '/add_channel <ссылка> [...], /channels, /del_channel <ссылка> [...]\n' +
    '/create_channel <название>\n\n' +
    '📣 Рассылка:\n' +
    '/post <текст> — рассылка текстом; пришли фото с подписью "/post текст" — разошлю картинку с подписью\n' +
    '/post <текст> ответом на сообщение с фото — разошлю то же фото с этим текстом\n' +
    '/tap <ссылка> @юз [количество] — тапнуть напрямую, без цепочки вз\n' +
    '/tap <ссылка на пост> — юз и ссылку на вз бот найдёт в посте сам (можно и ответом на пересланный пост)\n' +
    '/del_tap <ссылка|all> — забыть тап по посту (или все), можно тапнуть снова\n' +
    '/autopost, /autopost_text <текст>, /autopost_every <30м|2ч|1д>\n' +
    '/autopost_on, /autopost_off, /autopost_now\n\n' +
    '📤 Предложения ВЗ:\n' +
    '/offer — статус и помощь (там же /offer forget <@юз|id|all>)\n\n' +
    '⚙️ Прочее:\n' +
    '/settings — личные настройки\n' +
    '/set <параметр> <значение> — изменить настройку\n' +
    '/logs_channel <ссылка|off> — технический лог\n' +
    '/status — статус\n\n' +
    '🆘 Техподдержка:\n' +
    '/support <текст> — написать владельцу бота (можно приложить фото/скрин: пришли фото с подписью "/support текст" или ответом добавь /support <текст> к сообщению с фото)\n' +
    'Ответ придёт сюда же' +
    (isOwner ? '\n\nВладельцу: чтобы ответить — просто ответьте (reply) на пересланное сообщение из /support' : '')
  );
}

function setupBot(config, users, sessions) {
  const bot = new Telegraf(config.data.botToken);
  sessions.setBot(bot);

  // ---------- доступ ----------

  const isOwner = (ctx) => !!config.data.ownerId && String(ctx.from.id) === String(config.data.ownerId);
  const isRegistered = (ctx) => users.has(ctx.from.id);

  const PUBLIC_COMMANDS = ['/start', '/activate', '/help', '/support'];

  bot.use((ctx, next) => {
    if (!ctx.from || ctx.chat?.type !== 'private') return; // бот работает только в личке
    if (isRegistered(ctx)) return next();

    const raw = (ctx.message && (ctx.message.text || ctx.message.caption)) || '';
    const cmd = raw.split(/[\s@]/)[0];
    if (PUBLIC_COMMANDS.includes(cmd)) return next();

    return ctx.reply(
      '🔒 Доступ закрыт. Получите ключ у владельца бота и введите:\n/activate <ключ>'
    );
  });

  // удобные хелперы: данные и сессия ТЕКУЩЕГО пользователя
  const U = (ctx) => users.get(ctx.from.id);
  const S = (ctx) => sessions.get(ctx.from.id);

  function clientOf(ctx) {
    const s = S(ctx);
    if (!s.userbot.client) throw new Error('Аккаунт не подключён — сначала /login <номер>');
    return s.userbot.client;
  }

  // ---------- регистрация ----------

  bot.start(async (ctx) => {
    if (!config.data.ownerId) {
      config.data.ownerId = ctx.from.id;
      config.save();
      users.ensure(ctx.from.id, { username: ctx.from.username || null, key: 'owner' });
      await ctx.reply('👑 Вы назначены владельцем бота (первый /start). Ключи выдаются командой /genkey.');
    }
    if (!isRegistered(ctx)) {
      return ctx.reply('🔒 Нужна регистрация. Получите ключ у владельца бота и введите:\n/activate <ключ>');
    }
    await replyLong(ctx, helpText(isOwner(ctx)));
  });

  bot.command('help', (ctx) => {
    if (!isRegistered(ctx)) return ctx.reply('🔒 Сначала /activate <ключ>');
    return replyLong(ctx, helpText(isOwner(ctx)));
  });

  bot.command('genkey', (ctx) => {
    if (!isOwner(ctx)) return ctx.reply('🔒 Команда только для владельца бота');
    const key = generateKey();
    config.data.pendingKeys[key] = { createdAt: Date.now() };
    config.save();
    ctx.reply(`🔑 Ключ регистрации: \`${key}\`\nОдноразовый. Отправьте новому пользователю.`, { parse_mode: 'Markdown' });
  });

  bot.command('activate', (ctx) => {
    const key = parseArgs(ctx)[0];
    if (!key) return ctx.reply('Формат: /activate <ключ>');
    if (users.has(ctx.from.id)) return ctx.reply('Вы уже зарегистрированы. /start — список команд');

    const normalized = key.toUpperCase();
    if (!config.data.pendingKeys[normalized]) return ctx.reply('❌ Неверный или уже использованный ключ');

    delete config.data.pendingKeys[normalized];
    config.save();

    // ВАЖНО: карточка создаётся пустой — без чужих чатов, каналов и сессии
    users.create(ctx.from.id, { username: ctx.from.username || null, key: normalized });

    ctx.reply(
      '✅ Регистрация прошла успешно!\n\n' +
      'Дальше нужно подключить СВОЙ аккаунт Telegram:\n' +
      '1) /login +79990000000\n' +
      '2) /code <код из Telegram>\n' +
      '3) при 2FA — /password <пароль>\n\n' +
      'После этого добавьте свои чаты (/add_chat) и каналы (/add_channel).'
    );
  });

  bot.command('users', (ctx) => {
    if (!isOwner(ctx)) return ctx.reply('🔒 Команда только для владельца бота');
    const list = users.all();
    if (!list.length) return ctx.reply('Пользователей нет');
    const lines = list.map((u, i) =>
      `${i + 1}. id ${u.id}${u.username ? ' @' + u.username : ''}` +
      ` — вход: ${u.session ? 'да' : 'нет'}, чатов: ${u.chats.length}, каналов: ${u.channels.length}`
    );
    replyLong(ctx, `Пользователей: ${list.length}\n` + lines.join('\n'));
  });

  bot.command('revoke', async (ctx) => {
    if (!isOwner(ctx)) return ctx.reply('🔒 Команда только для владельца бота');
    const id = parseArgs(ctx)[0];
    if (!id) return ctx.reply('Формат: /revoke <id пользователя>');
    if (String(id) === String(config.data.ownerId)) return ctx.reply('Нельзя удалить владельца');
    if (!users.has(id)) return ctx.reply('Такого пользователя нет');
    await sessions.drop(id);
    users.remove(id);
    ctx.reply(`🗑 Пользователь ${id} удалён вместе со своими данными`);
  });

  // ---------- личная авторизация ----------

  bot.command('login', async (ctx) => {
    const u = U(ctx);
    const phone = parseArgs(ctx)[0] || u.phone;
    if (!phone) return ctx.reply('Формат: /login +79990000000');
    if (!/^\+?\d{7,15}$/.test(phone)) return ctx.reply('Похоже, это не номер. Формат: /login +79990000000');

    try {
      const s = S(ctx);
      await s.userbot.connect();
      if (await s.userbot.isAuthorized()) {
        return ctx.reply('Аккаунт уже подключён. Чтобы войти другим — сначала /logout');
      }
      const result = await s.userbot.sendCode(phone.startsWith('+') ? phone : '+' + phone);
      const WHERE = {
        SentCodeTypeApp: 'в другое уже открытое приложение Telegram (телефон/десктоп с этим же аккаунтом) — придёт сообщением от Telegram',
        SentCodeTypeSms: 'по SMS на телефон',
        SentCodeTypeCall: 'голосовым звонком на телефон',
        SentCodeTypeFlashCall: 'звонком-сбросом — код спрятан в номере звонившего',
        SentCodeTypeMissedCall: 'пропущенным звонком — код спрятан в номере звонившего',
        SentCodeTypeEmailCode: 'на привязанную к аккаунту почту'
      };
      const where = WHERE[result?.type?.className] || 'через Telegram';
      ctx.reply(`Код отправлен: ${where}.\nВведите: /code <код>\n(можно с пробелами: /code 1 2 3 4 5)`);
    } catch (e) {
      console.error('login error:', e);
      ctx.reply(`Ошибка: ${e.errorMessage || e.message}`);
    }
  });

  bot.command('code', async (ctx) => {
    const u = U(ctx);
    const code = ctx.message.text.split(' ').slice(1).join('');
    if (!code) return ctx.reply('Формат: /code 12345');
    try {
      const s = S(ctx);
      const res = await s.userbot.signIn(u.phone, code);
      if (res.twofa) return ctx.reply('Нужен пароль 2FA: /password <пароль>');
      await s.start();
      ctx.reply('✅ Аккаунт подключён. Добавьте чаты: /add_chat, каналы: /add_channel');
    } catch (e) {
      console.error('code error:', e);
      ctx.reply(`Ошибка: ${e.errorMessage || e.message}`);
    }
  });

  bot.command('password', async (ctx) => {
    const pwd = ctx.message.text.split(' ').slice(1).join(' ');
    if (!pwd) return ctx.reply('Формат: /password пароль');
    try {
      const s = S(ctx);
      await s.userbot.checkPassword(pwd);
      await s.start();
      ctx.reply('✅ Аккаунт подключён. Добавьте чаты: /add_chat, каналы: /add_channel');
    } catch (e) {
      console.error('password error:', e);
      ctx.reply(`Ошибка: ${e.errorMessage || e.message}`);
    }
  });

  bot.command('logout', async (ctx) => {
    try {
      const s = S(ctx);
      await s.stop();
      await s.userbot.logout();
      await sessions.drop(ctx.from.id);
      ctx.reply('👋 Вышли из аккаунта. Списки чатов и каналов сохранены. Вход снова — /login <номер>');
    } catch (e) {
      ctx.reply(`Ошибка: ${e.message}`);
    }
  });

  // Если у аккаунта уже есть живая сессия (эта самая) — при новом входе с телефона
  // Telegram шлёт код не SMS'ом, а сообщением от служебного аккаунта 777000.
  // Эта команда читает его через нашу сессию.
  bot.command('login_code', async (ctx) => {
    if (!isOwner(ctx)) return ctx.reply('🔒 Команда только для владельца бота');
    const s = S(ctx);
    try {
      await s.userbot.connect();
      if (!(await s.userbot.isAuthorized())) {
        return ctx.reply(
          'Текущая сессия недействительна — через бота код так не получить.\n' +
          'Нужно заново авторизоваться: /login <номер>, тогда Telegram пришлёт код по SMS или звонком.'
        );
      }
      const messages = await s.getServiceMessages(20);
      const withText = messages.filter((m) => m.message);
      if (!withText.length) return ctx.reply('В служебном чате Telegram (777000) пока пусто.');

      const lines = withText.map((m) => {
        const d = new Date(m.date * 1000);
        const p = (n) => String(n).padStart(2, '0');
        const time = `${p(d.getDate())}.${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
        return `[${time}] ${m.message}`;
      });
      await replyLong(ctx, `📨 Последние сообщения от Telegram:\n\n${lines.join('\n\n')}`);
    } catch (e) {
      ctx.reply(`Ошибка: ${e.errorMessage || e.message}`);
    }
  });

  bot.command('api', (ctx) => {
    const [apiId, apiHash] = parseArgs(ctx);
    const u = U(ctx);
    if (!apiId) {
      return ctx.reply(`Ваши api-ключи: ${u.apiId ? u.apiId + ' (свои)' : (config.data.apiId + ' (общие)')}\nСменить: /api <apiId> <apiHash>`);
    }
    if (!apiHash) return ctx.reply('Формат: /api <apiId> <apiHash>');
    u.apiId = Number(apiId);
    u.apiHash = apiHash;
    users.save();
    ctx.reply('Сохранено. Теперь /logout и заново /login <номер>');
  });

  // ---------- канал с договорами о вз ----------

  // Приводит ссылку/юз/id к виду, который потом можно отдать клиенту
  async function resolveTarget(ctx, ref) {
    const client = clientOf(ctx);
    const entity = await client.getEntity(ref);
    return { ref: entity.username ? '@' + entity.username : String(utils.getPeerId(entity)), title: entity.title || entity.username || ref };
  }

  bot.command('deals_channel', async (ctx) => {
    const u = U(ctx);
    const arg = parseArgs(ctx)[0];

    if (!arg) {
      return ctx.reply(
        u.dealsChannel
          ? `📄 Канал договоров: ${u.dealsChannel}\nСменить: /deals_channel <ссылка>\nОтключить: /deals_channel off`
          : 'Канал договоров не выбран.\nВыбрать: /deals_channel <ссылка|@юз|id>\nСоздать новый: /create_deals_channel <название>'
      );
    }

    if (['off', 'выкл', 'нет', '-'].includes(arg.toLowerCase())) {
      u.dealsChannel = '';
      users.save();
      return ctx.reply('Канал договоров отключён');
    }

    try {
      const { ref, title } = await resolveTarget(ctx, arg);
      // проверяем, что туда реально можно писать
      const client = clientOf(ctx);
      const probe = await client.sendMessage(ref, { message: '📄 Сюда будут приходить договоры о ВЗ' });
      u.dealsChannel = ref;
      users.save();
      ctx.reply(`✅ Канал договоров: «${title}» (${ref}).\nПроверочное сообщение отправлено (id ${probe.id}).`);
    } catch (e) {
      console.error('deals_channel error:', e);
      ctx.reply(`❌ Не вышло: ${e.errorMessage || e.message}\nУбедитесь, что ваш аккаунт состоит в канале и имеет право писать.`);
    }
  });

  bot.command('create_deals_channel', async (ctx) => {
    const title = ctx.message.text.replace(/^\/\S+\s*/, '').trim() || 'Договоры о ВЗ';
    try {
      const client = clientOf(ctx);
      const result = await client.invoke(new Api.channels.CreateChannel({
        title,
        about: 'Автоматические записи о договорах о ВЗ',
        broadcast: true,
        megagroup: false
      }));
      const channel = result.chats[0];
      const ref = channel.username ? '@' + channel.username : String(utils.getPeerId(channel));
      const u = U(ctx);
      u.dealsChannel = ref;
      users.save();
      await client.sendMessage(ref, { message: '📄 Канал создан. Сюда будут приходить договоры о ВЗ.' });
      ctx.reply(`✅ Канал «${title}» создан и выбран для договоров (${ref})`);
    } catch (e) {
      console.error('create_deals_channel error:', e);
      ctx.reply(`Ошибка: ${e.errorMessage || e.message}`);
    }
  });

  bot.command('logs_channel', async (ctx) => {
    const u = U(ctx);
    const arg = parseArgs(ctx)[0];
    if (!arg) {
      return ctx.reply(u.logsChannel ? `Лог-канал: ${u.logsChannel}\nОтключить: /logs_channel off` : 'Лог-канал не выбран: /logs_channel <ссылка>');
    }
    if (['off', 'выкл', 'нет', '-'].includes(arg.toLowerCase())) {
      u.logsChannel = '';
      users.save();
      return ctx.reply('Лог-канал отключён');
    }
    try {
      const { ref, title } = await resolveTarget(ctx, arg);
      u.logsChannel = ref;
      users.save();
      ctx.reply(`✅ Лог-канал: «${title}» (${ref})`);
    } catch (e) {
      ctx.reply(`❌ ${e.errorMessage || e.message}`);
    }
  });

  // ---------- чаты ----------

  async function resolveChat(ctx, ref) {
    const client = clientOf(ctx);
    const inviteMatch = ref.match(/(?:t\.me\/\+|t\.me\/joinchat\/)([\w-]+)/);
    if (!inviteMatch) {
      await client.getEntity(ref);
      return ref;
    }
    let chat;
    try {
      const res = await client.invoke(new Api.messages.ImportChatInvite({ hash: inviteMatch[1] }));
      chat = res.chats && res.chats[0];
    } catch (e) {
      if (e.errorMessage !== 'USER_ALREADY_PARTICIPANT') throw e;
      const info = await client.invoke(new Api.messages.CheckChatInvite({ hash: inviteMatch[1] }));
      chat = info.chat;
    }
    if (!chat) throw new Error('Не удалось получить данные чата после вступления');
    // сохраняем "размеченный" id (-100... для супергрупп), иначе gramjs потом
    // примет голый положительный id за пользователя и рассылка упадёт
    return String(utils.getPeerId(chat));
  }

  async function importFolder(ctx, ref) {
    const client = clientOf(ctx);
    const m = ref.match(/t\.me\/addlist\/([\w-]+)/);
    if (!m) throw new Error('Это не ссылка на папку (нужна t.me/addlist/...)');
    const slug = m[1];

    const info = await client.invoke(new Api.chatlists.CheckChatlistInvite({ slug }));
    const already = info.className === 'chatlists.ChatlistInviteAlready';
    const allPeers = already ? [...info.alreadyPeers, ...info.missingPeers] : info.peers;
    const toJoin = already ? info.missingPeers : info.peers;

    const byId = new Map(info.chats.map((c) => [c.id.toString(), c]));
    const peerId = (p) => (p.channelId ?? p.chatId ?? p.userId).toString();
    const toInputPeer = (p) => {
      const chat = byId.get(peerId(p));
      if (!chat) return null;
      if (p.className === 'PeerChannel') {
        return new Api.InputPeerChannel({ channelId: chat.id, accessHash: chat.accessHash });
      }
      if (p.className === 'PeerChat') return new Api.InputPeerChat({ chatId: chat.id });
      return null;
    };

    const inputPeers = toJoin.map(toInputPeer).filter(Boolean);
    if (inputPeers.length) {
      await client.invoke(new Api.chatlists.JoinChatlistInvite({ slug, peers: inputPeers }));
    }

    const markedId = (p) => (p.className === 'PeerChannel' ? '-100' + peerId(p) : '-' + peerId(p));
    const refs = allPeers
      .filter((p) => p.className === 'PeerChannel' || p.className === 'PeerChat')
      .map(markedId);

    let filterId = already ? info.filterId : null;
    if (filterId == null) {
      const after = await client.invoke(new Api.chatlists.CheckChatlistInvite({ slug }));
      if (after.className === 'chatlists.ChatlistInviteAlready') filterId = after.filterId;
    }
    return { slug, title: info.title || slug, refs, filterId };
  }

  async function deleteFolderInAccount(ctx, filterId) {
    const client = clientOf(ctx);
    await client.invoke(new Api.chatlists.LeaveChatlist({
      chatlist: new Api.InputChatlistDialogFilter({ filterId }),
      peers: []
    }));
  }

  bot.command('add_chat', async (ctx) => {
    const u = U(ctx);
    const refs = parseArgs(ctx);
    if (!refs.length) return ctx.reply('Укажи одну или несколько ссылок/username чатов');

    const lines = [];
    for (let i = 0; i < refs.length; i++) {
      const ref = refs[i];
      try {
        const storeRef = await resolveChat(ctx, ref);
        if (u.chats.includes(storeRef)) lines.push(`• уже в списке: ${storeRef}`);
        else {
          u.chats.push(storeRef);
          lines.push(`✅ ${storeRef}`);
        }
      } catch (e) {
        lines.push(`❌ ${ref}: ${e.errorMessage || e.message}`);
      }
      if (i < refs.length - 1) await sleep(1500);
    }
    users.save();
    S(ctx).ensureWatched();
    await replyLong(ctx, lines.join('\n'));
  });

  bot.command('add_folder', async (ctx) => {
    const u = U(ctx);
    const refs = parseArgs(ctx);
    if (!refs.length) return ctx.reply('Укажи ссылку: /add_folder https://t.me/addlist/...');

    for (const ref of refs) {
      try {
        const { slug, title, refs: chatRefs, filterId } = await importFolder(ctx, ref);
        const newlyAdded = [];
        for (const c of chatRefs) {
          if (!u.chats.includes(c)) {
            u.chats.push(c);
            newlyAdded.push(c);
          }
        }
        const existing = u.folders.find((f) => f.slug === slug);
        if (existing) {
          existing.chats = chatRefs;
          existing.added = [...new Set([...(existing.added || []), ...newlyAdded])];
          if (filterId != null) existing.filterId = filterId;
        } else {
          u.folders.push({ slug, title, filterId, chats: chatRefs, added: newlyAdded });
        }
        users.save();
        S(ctx).ensureWatched();

        await ctx.reply(
          `📁 Папка «${title}»: чатов ${chatRefs.length}, новых ${newlyAdded.length}, уже были ${chatRefs.length - newlyAdded.length}`
        );
      } catch (e) {
        await ctx.reply(`❌ ${ref}: ${e.errorMessage || e.message}`);
      }
    }
  });

  bot.command('folders', (ctx) => {
    const u = U(ctx);
    if (!u.folders.length) return ctx.reply('Папок нет');
    replyLong(ctx, u.folders
      .map((f, i) => `${i + 1}. «${f.title}» — чатов: ${f.chats.length}\n   t.me/addlist/${f.slug}`)
      .join('\n'));
  });

  bot.command('del_folder', async (ctx) => {
    const u = U(ctx);
    const args = parseArgs(ctx);
    if (!args.length) return ctx.reply('Укажи номер из /folders или ссылку на папку');

    const targets = [];
    for (const arg of args) {
      let folder;
      if (/^\d+$/.test(arg)) folder = u.folders[Number(arg) - 1];
      else {
        const m = arg.match(/t\.me\/addlist\/([\w-]+)/);
        folder = u.folders.find((f) => f.slug === (m ? m[1] : arg));
      }
      if (!folder) await ctx.reply(`❌ Папка не найдена: ${arg}`);
      else if (!targets.includes(folder)) targets.push(folder);
    }

    for (const folder of targets) {
      const others = u.folders.filter((f) => f !== folder);
      const keep = new Set(others.flatMap((f) => f.chats));
      const toRemove = (folder.added || []).filter((c) => !keep.has(c));
      u.chats = u.chats.filter((c) => !toRemove.includes(c));

      let warn = '';
      if (folder.filterId != null) {
        try {
          await deleteFolderInAccount(ctx, folder.filterId);
        } catch (e) {
          warn = `\n⚠️ Из бота убрана, но в аккаунте удалить не вышло: ${e.errorMessage || e.message}`;
        }
      } else {
        warn = '\n⚠️ id папки неизвестен — удалите её в Telegram вручную';
      }

      u.folders.splice(u.folders.indexOf(folder), 1);
      users.save();
      S(ctx).ensureWatched();
      await ctx.reply(`🗑 Папка «${folder.title}» удалена, чатов убрано: ${toRemove.length}${warn}`);
    }
  });

  bot.command('chats', (ctx) => {
    const u = U(ctx);
    replyLong(ctx, u.chats.length ? `Вз-чатов: ${u.chats.length}\n` + u.chats.join('\n') : 'Список пуст');
  });

  // Чинит старые записи: голый id -> "размеченный" (-100...), который понимает gramjs
  bot.command('fix_chats', async (ctx) => {
    const u = U(ctx);
    const s = S(ctx);
    if (!u.chats.length) return ctx.reply('Список пуст');
    await ctx.reply('Проверяю чаты…');

    const map = new Map();
    const bad = [];
    for (const ref of u.chats) {
      try {
        const peer = await s.resolvePeer(ref);
        const marked = String(utils.getPeerId(peer));
        map.set(ref, marked);
      } catch (e) {
        bad.push(`${ref}: ${e.message}`);
      }
    }

    let changed = 0;
    u.chats = u.chats.map((ref) => {
      const marked = map.get(ref);
      if (marked && marked !== ref) {
        changed++;
        return marked;
      }
      return ref;
    });
    u.chats = [...new Set(u.chats)];

    // те же замены внутри папок, иначе /del_folder перестанет находить свои чаты
    for (const f of u.folders) {
      f.chats = (f.chats || []).map((c) => map.get(c) || c);
      f.added = (f.added || []).map((c) => map.get(c) || c);
    }

    users.save();
    s.peers.clear();
    s.ensureWatched();

    await replyLong(ctx,
      `✅ Исправлено записей: ${changed}. Всего чатов: ${u.chats.length}.` +
      (bad.length ? `\n\n❌ Не удалось распознать (${bad.length}):\n` + bad.join('\n') : '')
    );
  });

  bot.command('del_chat', (ctx) => {
    const u = U(ctx);
    const refs = parseArgs(ctx);
    if (!refs.length) return ctx.reply('Укажи ссылку/id чата (см. /chats)');
    const before = u.chats.length;
    u.chats = u.chats.filter((c) => !refs.includes(c));
    users.save();
    S(ctx).ensureWatched();
    ctx.reply(`Удалено: ${before - u.chats.length} из ${refs.length}`);
  });

  bot.command('del_all_chats', (ctx) => {
    const u = U(ctx);
    const count = u.chats.length;
    if (!count) return ctx.reply('Список уже пуст');
    const arg = (parseArgs(ctx)[0] || '').toLowerCase();
    if (!['да', 'yes', 'confirm'].includes(arg)) {
      return ctx.reply(`Будет удалено вз-чатов: ${count}.\nПодтвердите: /del_all_chats да`);
    }
    u.chats = [];
    users.save();
    S(ctx).ensureWatched();
    ctx.reply(`🗑 Удалено вз-чатов: ${count}`);
  });

  // ---------- каналы для тапов ----------

  bot.command('add_channel', async (ctx) => {
    const u = U(ctx);
    const refs = parseArgs(ctx);
    if (!refs.length) return ctx.reply('Укажи одну или несколько ссылок/username каналов');

    const lines = [];
    for (const ref of refs) {
      if (u.channels.includes(ref)) lines.push(`• уже в списке: ${ref}`);
      else {
        u.channels.push(ref);
        lines.push(`✅ ${ref}`);
      }
    }
    users.save();
    await replyLong(ctx, lines.join('\n'));
  });

  bot.command('channels', (ctx) => {
    const u = U(ctx);
    replyLong(ctx, u.channels.length ? `Каналов: ${u.channels.length}\n` + u.channels.join('\n') : 'Список пуст');
  });

  bot.command('del_channel', (ctx) => {
    const u = U(ctx);
    const refs = parseArgs(ctx);
    if (!refs.length) return ctx.reply('Укажи ссылку/username канала (см. /channels)');
    const before = u.channels.length;
    u.channels = u.channels.filter((c) => !refs.includes(c));
    users.save();
    ctx.reply(`Удалено: ${before - u.channels.length} из ${refs.length}`);
  });

  bot.command('create_channel', async (ctx) => {
    const title = ctx.message.text.replace(/^\/\S+\s*/, '').trim();
    if (!title) return ctx.reply('Укажи название');
    try {
      const client = clientOf(ctx);
      const result = await client.invoke(new Api.channels.CreateChannel({
        title, about: 'vz', broadcast: true, megagroup: false
      }));
      const channel = result.chats[0];
      const ref = channel.username ? '@' + channel.username : String(utils.getPeerId(channel));
      U(ctx).channels.push(ref);
      users.save();
      ctx.reply(`Канал создан: ${ref}`);
    } catch (e) {
      ctx.reply(`Ошибка: ${e.errorMessage || e.message}`);
    }
  });

  // ---------- рассылка ----------

  function extractPayload(ctx) {
    const full = ctx.message.text;
    const m = full.match(/^\/\S+\s*/);
    const prefixLen = m ? m[0].length : full.length;
    const text = full.slice(prefixLen).trimEnd();
    const entities = (ctx.message.entities || [])
      .filter((e) => e.type === 'custom_emoji' && e.offset >= prefixLen && e.offset < prefixLen + text.length)
      .map((e) => ({ offset: e.offset - prefixLen, length: e.length, documentId: String(e.custom_emoji_id) }));
    return { text, entities };
  }

  // то же самое, но текст берём из подписи к фото (caption / caption_entities)
  function extractCaptionPayload(ctx, stripCommand) {
    const full = ctx.message.caption || '';
    let prefixLen = 0;
    if (stripCommand) {
      const m = full.match(/^\/\S+\s*/);
      prefixLen = m ? m[0].length : 0;
    }
    const text = full.slice(prefixLen).trimEnd();
    const entities = (ctx.message.caption_entities || [])
      .filter((e) => e.type === 'custom_emoji' && e.offset >= prefixLen && e.offset < prefixLen + text.length)
      .map((e) => ({ offset: e.offset - prefixLen, length: e.length, documentId: String(e.custom_emoji_id) }));
    return { text, entities };
  }

  // Скачивает самое крупное фото из массива message.photo и заворачивает в CustomFile для gramjs
  async function downloadTgPhoto(ctx, photoArr) {
    const best = photoArr[photoArr.length - 1];
    const link = await ctx.telegram.getFileLink(best.file_id);
    const buf = await fetchBuffer(typeof link === 'string' ? link : link.href);
    return new CustomFile(`photo_${best.file_id}.jpg`, buf.length, '', buf);
  }

  async function doBroadcast(ctx, text, entities, file) {
    const u = U(ctx);
    if (!text && !file) return ctx.reply('Укажи текст (или пришли фото с подписью)');
    if (!u.chats.length) return ctx.reply('Нет вз-чатов');
    try {
      const { sent, total, errors } = await S(ctx).broadcast(text, entities, file);
      let out = sent === total ? `Разослано в ${sent} чатов` : `Разослано в ${sent} из ${total} чатов`;
      if (errors && errors.length) {
        out += `\n\nНе ушло (${errors.length}):\n` + errors.slice(0, 20).join('\n');
        if (errors.length > 20) out += `\n…и ещё ${errors.length - 20}`;
        out += '\n\nЕсли причина «Could not find the input entity» — выполните /fix_chats';
      }
      await replyLong(ctx, out);
    } catch (e) {
      ctx.reply(`Ошибка: ${e.message}`);
    }
  }

  // ---------- техподдержка ----------

  function pruneSupportThreads() {
    const entries = Object.entries(config.data.supportThreads || {});
    if (entries.length <= 1000) return;
    entries.sort((a, b) => (a[1].at || 0) - (b[1].at || 0));
    for (const [k] of entries.slice(0, entries.length - 1000)) delete config.data.supportThreads[k];
  }

  async function forwardToSupport(ctx, text, photoFileId) {
    const ownerId = config.data.ownerId;
    if (!ownerId) return ctx.reply('Техподдержка временно недоступна — у бота не задан владелец.');
    if (String(ctx.from.id) === String(ownerId)) {
      return ctx.reply('Вы — владелец бота, писать в техподдержку самому себе незачем 🙂');
    }
    if (!text && !photoFileId) return ctx.reply('Опишите проблему: /support <текст> (можно приложить фото)');

    const fromName = ctx.from.username ? `@${ctx.from.username}` : (ctx.from.first_name || 'без имени');
    const body = `📩 Обращение в поддержку\nОт: ${fromName} (id: ${ctx.from.id})\n\n${text || ''}`.trim();

    try {
      const sent = photoFileId
        ? await ctx.telegram.sendPhoto(ownerId, photoFileId, { caption: body.slice(0, 1024) })
        : await ctx.telegram.sendMessage(ownerId, body);

      config.data.supportThreads[String(sent.message_id)] = {
        userId: String(ctx.from.id),
        username: ctx.from.username || null,
        at: Date.now()
      };
      pruneSupportThreads();
      config.save();
      await ctx.reply('✅ Сообщение отправлено в поддержку. Ответ придёт сюда же.');
    } catch (e) {
      await ctx.reply(`Не удалось отправить в поддержку: ${e.message}`);
    }
  }

  bot.command('support', async (ctx) => {
    const { text } = extractPayload(ctx);
    // /support <текст> ответом на сообщение с фото — прикладываем это фото
    const repliedPhoto = ctx.message.reply_to_message && ctx.message.reply_to_message.photo;
    const photoFileId = repliedPhoto ? repliedPhoto[repliedPhoto.length - 1].file_id : null;
    await forwardToSupport(ctx, text, photoFileId);
  });

  bot.command('post', async (ctx) => {
    const { text, entities } = extractPayload(ctx);

    // /post <текст> ответом на сообщение с фото — картинку берём из него
    let file = null;
    const repliedPhoto = ctx.message.reply_to_message && ctx.message.reply_to_message.photo;
    if (repliedPhoto) {
      try {
        file = await downloadTgPhoto(ctx, repliedPhoto);
      } catch (e) {
        return ctx.reply(`Не смог скачать фото из ответа: ${e.message}`);
      }
    }

    await doBroadcast(ctx, text, entities, file);
  });

  // Фото с подписью "/post текст…" — рассылаем картинку с текстом как есть.
  // Фото с подписью "/support текст…" — уходит в техподдержку.
  // Фото-ответ владельца на обращение в поддержку — уходит обратно пользователю.
  bot.on('photo', async (ctx) => {
    const caption = ctx.message.caption || '';

    if (/^\/post(?:@\w+)?(\s|$)/.test(caption)) {
      const { text, entities } = extractCaptionPayload(ctx, true);
      let file;
      try {
        file = await downloadTgPhoto(ctx, ctx.message.photo);
      } catch (e) {
        return ctx.reply(`Не смог скачать фото: ${e.message}`);
      }
      return doBroadcast(ctx, text, entities, file);
    }

    if (/^\/support(?:@\w+)?(\s|$)/.test(caption)) {
      const { text } = extractCaptionPayload(ctx, true);
      const photoFileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
      return forwardToSupport(ctx, text, photoFileId);
    }

    // владелец отвечает фото в треде поддержки
    if (isOwner(ctx)) {
      const replied = ctx.message.reply_to_message;
      const thread = replied && config.data.supportThreads[String(replied.message_id)];
      if (thread) {
        const photoFileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
        try {
          await ctx.telegram.sendPhoto(thread.userId, photoFileId, {
            caption: caption ? `🛠 Ответ от поддержки:\n\n${caption}` : '🛠 Ответ от поддержки'
          });
          await ctx.reply('✅ Отправлено пользователю');
        } catch (e) {
          await ctx.reply(`Не смог отправить: ${e.message}`);
        }
      }
    }
  });

  bot.command('tap', async (ctx) => {
    const u = U(ctx);
    const s = S(ctx);
    if (!s.running || !s.tapper) return ctx.reply('Аккаунт не подключён — сначала /login <номер>');
    if (!u.channels.length) return ctx.reply('Нет каналов для тапов (/add_channel)');

    const body = ctx.message.text.replace(/^\/\S+\s*/, '');
    let parsed = parser.parseVzMessage(body, true);

    // В команде нет явного юза — пробуем вытащить его прямо из поста:
    // 1) если дали ссылку на сообщение в чате/канале — подтягиваем его текст;
    // 2) если /tap отправлен ответом на пересланный пост — берём текст оттуда.
    if (!parsed) {
      const ref = parser.parseMessageLink(body);
      if (ref) {
        try {
          const [linked] = await s.client.getMessages(ref.peer, { ids: [ref.id] });
          if (linked) parsed = parser.parseVzMessage(parser.messageToText(linked), true);
        } catch (e) {
          console.log('tap: linked message error', e.errorMessage || e.message);
        }
      }
    }

    if (!parsed && ctx.message.reply_to_message) {
      const replied = ctx.message.reply_to_message;
      const repliedText = replied.text || replied.caption || '';
      parsed = parser.parseVzMessage(repliedText, true);
    }

    if (!parsed) {
      return ctx.reply(
        'Формат: /tap <ссылка на пост> @юз [количество]\n' +
        'Либо просто /tap <ссылка на сообщение с постом> — ссылку и юз возьму из него самого\n' +
        'Либо ответьте командой /tap на пересланный пост'
      );
    }

    try {
      await ctx.reply(`Тапаю: @${parsed.username} | ${parsed.link}…`);
      const result = await s.tapper.tap(parsed.link, parsed.username, parsed.count || u.defaultVotes);
      ctx.reply(`✅ Тап выполнен: @${parsed.username} | ${parsed.link} | каналов: ${result.total}`);
    } catch (e) {
      ctx.reply(`❌ Ошибка тапа: ${e.errorMessage || e.message}`);
    }
  });

  // Забыть, что пост уже тапали — чтобы можно было тапнуть его снова
  // (тап хранится в u.tapped по ключу "entity.id_postId", см. tapper.js)
  bot.command('del_tap', async (ctx) => {
    const u = U(ctx);
    const s = S(ctx);
    const arg = ctx.message.text.replace(/^\/\S+\s*/, '').trim();
    if (!arg) {
      return ctx.reply('Формат: /del_tap <ссылка на пост> — забыть тапы по этому посту, чтобы тапнуть снова\nОчистить всё: /del_tap all');
    }

    if (arg.toLowerCase() === 'all') {
      const count = Object.keys(u.tapped).length;
      u.tapped = {};
      users.save();
      return ctx.reply(`🗑 Забыл про все тапнутые посты (${count})`);
    }

    if (!s.tapper) return ctx.reply('Аккаунт не подключён — сначала /login <номер>');
    try {
      const { entity, postId } = await s.tapper.resolveLink(arg);
      if (!postId) return ctx.reply('В ссылке нет номера поста — нужна ссылка вида t.me/chat/123');
      const key = `${entity.id}_${postId}`;
      if (!u.tapped[key]) return ctx.reply('По этой ссылке записанных тапов нет');
      const channelsCount = u.tapped[key].length;
      delete u.tapped[key];
      users.save();
      ctx.reply(`🗑 Забыл тапы по этому посту (было каналов: ${channelsCount}) — можно тапнуть снова`);
    } catch (e) {
      ctx.reply(`❌ ${e.errorMessage || e.message}`);
    }
  });

  // ---------- автопост ----------

  function autopostStatus(u) {
    const ap = u.autopost;
    const preview = ap.text ? (ap.text.length > 200 ? ap.text.slice(0, 200) + '…' : ap.text) : 'не задан';
    const lines = [
      `📣 Автопост: ${ap.enabled ? 'включён' : 'выключен'}`,
      `Частота: ${ap.intervalMin ? 'каждые ' + fmtMinutes(ap.intervalMin) : 'не задана'}`,
      `Текст: ${preview}`,
      `Вз-чатов: ${u.chats.length}`
    ];
    if (ap.enabled && ap.nextAt) lines.push(`Следующая: через ${fmtMinutes((ap.nextAt - Date.now()) / 60000)}`);
    if (ap.lastAt) lines.push(`Последняя: ${fmtMinutes((Date.now() - ap.lastAt) / 60000)} назад${ap.lastResult ? ` (${ap.lastResult})` : ''}`);
    return lines.join('\n');
  }

  bot.command('autopost', (ctx) => {
    ctx.reply(
      autopostStatus(U(ctx)) + '\n\n' +
      'Настройка:\n/autopost_text <текст>\n/autopost_every <30м | 2ч | 1д> (минимум ' + MIN_INTERVAL_MIN + ' мин)\n' +
      '/autopost_on\n/autopost_off\n/autopost_now'
    );
  });

  bot.command('autopost_text', (ctx) => {
    const { text, entities } = extractPayload(ctx);
    if (!text) return ctx.reply('Формат: /autopost_text <текст рассылки>');
    const ap = U(ctx).autopost;
    ap.text = text;
    ap.entities = entities;
    users.save();
    ctx.reply(`Текст автопоста сохранён (${text.length} симв.)`);
  });

  bot.command('autopost_every', (ctx) => {
    const arg = parseArgs(ctx).join('');
    if (!arg) return ctx.reply(`Формат: /autopost_every 30м | 2ч | 1д (минимум ${MIN_INTERVAL_MIN} мин)`);
    const minutes = parseInterval(arg);
    if (!minutes) return ctx.reply('Не понял интервал. Примеры: 30м, 2ч, 1.5ч, 1д');
    if (minutes < MIN_INTERVAL_MIN) return ctx.reply(`Слишком часто: минимум ${MIN_INTERVAL_MIN} мин`);
    if (minutes > MAX_INTERVAL_MIN) return ctx.reply('Слишком редко: максимум 30 дней');

    const ap = U(ctx).autopost;
    ap.intervalMin = minutes;
    if (ap.enabled) ap.nextAt = Date.now() + minutes * 60000;
    users.save();
    ctx.reply(`Частота: каждые ${fmtMinutes(minutes)}`);
  });

  bot.command('autopost_on', (ctx) => {
    const u = U(ctx);
    const ap = u.autopost;
    if (!ap.text) return ctx.reply('Сначала задай текст: /autopost_text <текст>');
    if (!ap.intervalMin) return ctx.reply('Сначала задай частоту: /autopost_every 2ч');
    if (!u.chats.length) return ctx.reply('Нет вз-чатов');
    ap.enabled = true;
    ap.nextAt = Date.now() + ap.intervalMin * 60000;
    users.save();
    ctx.reply(`✅ Автопост включён: каждые ${fmtMinutes(ap.intervalMin)}. Разослать сразу — /autopost_now`);
  });

  bot.command('autopost_off', (ctx) => {
    const ap = U(ctx).autopost;
    ap.enabled = false;
    ap.nextAt = null;
    users.save();
    ctx.reply('⏹ Автопост выключен');
  });

  bot.command('autopost_now', async (ctx) => {
    const u = U(ctx);
    const s = S(ctx);
    if (!u.autopost.text) return ctx.reply('Сначала задай текст: /autopost_text <текст>');
    if (!u.chats.length) return ctx.reply('Нет вз-чатов');
    if (s.autopostBusy) return ctx.reply('Рассылка уже идёт');
    await ctx.reply('Рассылаю…');
    try {
      const { sent, total } = await s.runAutopost();
      ctx.reply(`Разослано в ${sent} из ${total} чатов`);
    } catch (e) {
      ctx.reply(`Ошибка: ${e.message}`);
    }
  });

  // ---------- настройки и статус ----------

  const SETTABLE = {
    votes: ['defaultVotes', 'число тапов по умолчанию'],
    confirm: ['confirmKeyword', 'что отвечаем на предложение'],
    done: ['doneKeyword', 'что отвечаем после тапа'],
    afteryou: ['afterYouReply', 'ответ на «тап после вас»'],
    general: ['answerGeneralOffers', 'отвечать на общие предложения в чат (да/нет)']
  };

  bot.command('settings', (ctx) => {
    const u = U(ctx);
    ctx.reply(
      'Личные настройки:\n' +
      `votes = ${u.defaultVotes}\n` +
      `confirm = ${u.confirmKeyword}\n` +
      `done = ${u.doneKeyword}\n` +
      `afteryou = ${u.afterYouReply}\n` +
      `general = ${u.answerGeneralOffers ? 'да' : 'нет'}\n\n` +
      'Изменить: /set <параметр> <значение>\nНапример: /set votes 30'
    );
  });

  bot.command('set', (ctx) => {
    const u = U(ctx);
    const parts = ctx.message.text.split(/\s+/).slice(1);
    const name = (parts[0] || '').toLowerCase();
    const value = parts.slice(1).join(' ');
    if (!SETTABLE[name] || !value) {
      return ctx.reply('Формат: /set <votes|confirm|done|afteryou|general> <значение>');
    }
    const field = SETTABLE[name][0];
    if (field === 'defaultVotes') {
      const n = parseInt(value, 10);
      if (!n || n < 1) return ctx.reply('Нужно целое число больше 0');
      u.defaultVotes = n;
    } else if (field === 'answerGeneralOffers') {
      u.answerGeneralOffers = ['да', 'yes', 'on', 'true', '1'].includes(value.toLowerCase());
    } else {
      u[field] = value;
    }
    users.save();
    ctx.reply(`✅ ${name} = ${u[field] === true ? 'да' : u[field] === false ? 'нет' : u[field]}`);
  });

  bot.command('status', async (ctx) => {
    const u = U(ctx);
    const s = S(ctx);
    const auth = await s.userbot.isAuthorized();
    ctx.reply(
      `👤 Ваш id: ${u.id}\n` +
      `Аккаунт: ${auth ? 'подключён' + (u.phone ? ' (' + u.phone + ')' : '') : 'не подключён — /login <номер>'}\n` +
      `Слежение: ${s.running ? 'работает' : 'остановлено'}\n` +
      `Вз-чатов: ${u.chats.length}\n` +
      `Каналов для тапов: ${u.channels.length}\n` +
      `Канал договоров: ${u.dealsChannel || 'не выбран (/deals_channel)'}\n` +
      `Лог-канал: ${u.logsChannel || 'не выбран'}\n` +
      `Автопост: ${u.autopost.enabled ? 'каждые ' + fmtMinutes(u.autopost.intervalMin) : 'выключен'}`
    );
  });

  // Ответ владельца текстом на пересланное обращение в поддержку —
  // сюда попадают только сообщения, не подошедшие ни под одну команду выше
  // ⚠️ Этот обработчик стоит до registerOfferCommands (/offer регистрируется
  // ниже), поэтому обязательно вызывает next() во всех веток, где сообщение
  // не относится к пересылке ответа поддержки — иначе более поздние команды
  // (в частности /offer) вообще перестают доходить до своих хендлеров.
  bot.on('text', async (ctx, next) => {
    if (!isOwner(ctx)) return next();
    const replied = ctx.message.reply_to_message;
    if (!replied) return next();
    const thread = config.data.supportThreads[String(replied.message_id)];
    if (!thread) return next();

    try {
      await ctx.telegram.sendMessage(thread.userId, `🛠 Ответ от поддержки:\n\n${ctx.message.text}`);
      await ctx.reply('✅ Отправлено пользователю');
    } catch (e) {
      await ctx.reply(`Не смог отправить: ${e.message}`);
    }
  });

  bot.catch((err, ctx) => {
    console.error('bot error:', err);
    try { ctx.reply(`Ошибка: ${err.message}`); } catch {}
  });

  registerOfferCommands(bot, users, sessions);

  bot.launch();
  return bot;
}

module.exports = setupBot;
