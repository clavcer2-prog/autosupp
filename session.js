const { Proposer } = require('./offers');
const bigInt = require('big-integer');
const { NewMessage } = require('telegram/events');
const { Api, utils } = require('telegram');

const Userbot = require('./userbot');
const Tapper = require('./tapper');
const parser = require('./parser');

const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е');

// "тап после вас", "тапну после вас", "тапаю после вас"
const AFTER_YOU_RE = /тап\S*\s+после\s+вас/;
// голое "тап" / "тапаю" / "тапни" и т.п. — сразу тапаем
const TAP_RE = /(?<![а-яa-z])тап\S*/;
// просто "тап" одним словом, без ничего вокруг — сигнал тапнуть по цитируемому сообщению
const TAP_ONLY_RE = /^тап[!.]*$/;
// "вз" отдельным словом либо "взаимка/взаимно"
const VZ_WORD_RE = /(?<![а-яa-z])вз(?![а-яa-z])|взаимк|взаимн/;
const AFTER_YOU_REPLY_DEFAULT = 'тап, сообщите';

const OWNPOSTS_TTL_MS = 30 * 24 * 3600 * 1000; // как долго помним свои сообщения
const OWNPOSTS_MAX = 5000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fmtTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Всё, что происходит от имени одного пользователя: его клиент, его чаты,
// его каналы, его автопост, его канал с договорами.
class UserSession {
  constructor(user, config, users, bot) {
    this.user = user;
    this.config = config;
    this.users = users;
    this.bot = bot; // telegraf — чтобы писать пользователю в личку

    this.userbot = new Userbot(user, config, users);
    this.tapper = null;
    this.handler = null;
    this.running = false;
    this.autopostBusy = false;

    this.contexts = new Map(); // наши "сообщите" -> данные предложения
    this.watched = new Set();
    this.resolvedRefs = new Map();
    this.peers = new Map(); // ref -> InputPeer (кэш, чтобы не дёргать API на каждую рассылку)
    this.dialogsPrimedAt = 0;
    this.titles = new Map();
    this.watchedSig = null;
    this.watchedAt = 0;
    this.refreshing = null;
    this.proposer = new Proposer(this);
  }

  // Сообщения, которые реально отправил ВЗ-модуль (автопост, предложения, наше "вз").
  // Хранятся в users.json и переживают перезапуск.
  hasOwnPost(key) {
    return !!this.user.ownPosts[key];
  }

  addOwnPost(key, save = true) {
    const posts = this.user.ownPosts;
    posts[key] = Date.now();
    const keys = Object.keys(posts);
    if (keys.length > OWNPOSTS_MAX) {
      const now = Date.now();
      for (const k of keys) if (now - posts[k] > OWNPOSTS_TTL_MS) delete posts[k];
      const left = Object.keys(posts);
      if (left.length > OWNPOSTS_MAX) {
        left.sort((a, b) => posts[a] - posts[b]).slice(0, left.length - OWNPOSTS_MAX).forEach((k) => delete posts[k]);
      }
    }
    if (save) this.users.save();
  }

  get client() {
    return this.userbot.client;
  }

  requireClient() {
    if (!this.userbot.client) throw new Error('Аккаунт не подключён — сначала /login <номер>');
    return this.userbot.client;
  }

  // ---------- запуск / остановка ----------

  async start() {
    if (this.running) return;
    if (!this.user.session) throw new Error('Нет сессии — нужна авторизация /login');

    await this.userbot.connect();
    if (!(await this.userbot.isAuthorized())) {
      throw new Error('Сессия недействительна, нужна повторная авторизация /login');
    }

    this.tapper = new Tapper(this.client, this.user, this.users);
    this.handler = (event) => this.onMessage(event).catch((e) => console.log('handler error', e.message));
    this.client.addEventHandler(this.handler, new NewMessage({}));
    this.running = true;

    await this.primeDialogs();
    await this.ensureWatched();
    console.log(`[user ${this.user.id}] сессия запущена, чатов: ${this.user.chats.length}`);
  }

  async stop() {
    if (this.handler && this.client) {
      try { this.client.removeEventHandler(this.handler, new NewMessage({})); } catch {}
    }
    this.handler = null;
    this.running = false;
    await this.userbot.disconnect();
  }

  // ---------- логи и уведомления ----------

  async log(text) {
    console.log(`[user ${this.user.id}] ${text}`);
    if (!this.user.logsChannel || !this.client) return;
    try {
      await this.client.sendMessage(this.user.logsChannel, { message: text });
    } catch (e) {
      console.log('log error', e.message);
    }
  }

  async notify(text) {
    if (!this.bot) return;
    try {
      await this.bot.telegram.sendMessage(this.user.id, text);
    } catch (e) {
      console.log('notify error', e.message);
    }
  }

  // ---------- канал с договорами о вз ----------

  async chatTitle(chatId) {
    const key = String(chatId);
    if (this.titles.has(key)) return this.titles.get(key);
    let title = key;
    try {
      const e = await this.client.getEntity(chatId);
      title = e.title || e.username || key;
    } catch {}
    this.titles.set(key, title);
    return title;
  }

  dealText(ctx, status, extra) {
    const head = status === 'done' ? '✅ Договор о ВЗ выполнен'
      : status === 'failed' ? '❌ Договор о ВЗ — ошибка'
        : '🤝 Договор о ВЗ';
    const lines = [
      head,
      `👤 Партнёр: @${ctx.username}`,
      `🔗 Пост: ${ctx.link}`,
      `🔢 Тапов: ${ctx.count}`,
      `💬 Чат: ${ctx.chatTitle || ctx.chatId}`,
      `🕒 ${fmtTime(Date.now())}`
    ];
    if (ctx.offerLink) lines.push(`📌 Предложение: ${ctx.offerLink}`);
    if (extra) lines.push(extra);
    return lines.join('\n');
  }

  // Отправляет карточку договора в личный канал пользователя.
  // Возвращает id сообщения, чтобы потом его же отредактировать при выполнении.
  async postDeal(ctx, status, extra) {
    const target = this.user.dealsChannel;
    if (!target || !this.client) return null;
    const text = this.dealText(ctx, status, extra);
    try {
      if (ctx.dealMsgId) {
        await this.client.editMessage(target, { message: ctx.dealMsgId, text });
        return ctx.dealMsgId;
      }
      const sent = await this.client.sendMessage(target, { message: text });
      return sent.id;
    } catch (e) {
      console.log('deals channel error', e.errorMessage || e.message);
      // если отредактировать не вышло — просто шлём новым сообщением
      if (ctx.dealMsgId) {
        try {
          const sent = await this.client.sendMessage(target, { message: text });
          return sent.id;
        } catch {}
      }
      return ctx.dealMsgId || null;
    }
  }

  // ---------- список отслеживаемых чатов ----------

  // gramjs умеет отправлять по id только если этот чат есть в его кэше сущностей.
  // Кэш наполняется списком диалогов — иначе id вида "5339223874" он принимает
  // за id пользователя и падает с "Could not find the input entity ... PeerUser".
  async primeDialogs(force = false) {
    if (!this.client) return;
    if (!force && Date.now() - this.dialogsPrimedAt < 10 * 60 * 1000) return;
    try {
      await this.client.getDialogs({ limit: 500 });
      this.dialogsPrimedAt = Date.now();
    } catch (e) {
      console.log('primeDialogs error', e.errorMessage || e.message);
    }
  }

  // Последние сообщения от официального служебного аккаунта Telegram (id 777000).
  // Туда прилетает код входа, если у аккаунта уже есть другая живая сессия —
  // в этом случае Telegram не шлёт SMS/звонок, и код можно прочитать отсюда.
  async getServiceMessages(limit = 5) {
    const client = this.requireClient();
    await this.primeDialogs();
    try {
      return await client.getMessages('777000', { limit });
    } catch (e) {
      await this.primeDialogs(true);
      return await client.getMessages('777000', { limit });
    }
  }

  // Превращает сохранённую ссылку/id в InputPeer.
  // Голый положительный id может означать и супергруппу (-100...), и обычную
  // группу (-...), поэтому пробуем оба варианта.
  async peerCandidates(ref) {
    if (!/^-?\d+$/.test(ref)) return [ref];
    if (ref.startsWith('-')) return [ref];
    const n = bigInt(ref);
    return [
      bigInt('-1000000000000').subtract(n).toString(),
      bigInt(0).subtract(n).toString(),
      ref
    ];
  }

  async resolvePeer(ref, retried = false) {
    if (this.peers.has(ref)) return this.peers.get(ref);
    const client = this.requireClient();
    const candidates = await this.peerCandidates(ref);

    let lastErr = null;
    for (const c of candidates) {
      try {
        const peer = await client.getInputEntity(c);
        this.peers.set(ref, peer);
        return peer;
      } catch (e) {
        lastErr = e;
      }
    }

    // не нашли — возможно, чат появился уже после прогрева кэша
    if (!retried) {
      await this.primeDialogs(true);
      return this.resolvePeer(ref, true);
    }
    throw new Error(lastErr ? (lastErr.errorMessage || lastErr.message) : 'чат не найден');
  }

  async resolveChatIds(ref) {
    if (/^-?\d+$/.test(ref)) {
      if (ref.startsWith('-')) return [ref];
      const n = bigInt(ref);
      return [
        bigInt('-1000000000000').subtract(n).toString(), // канал / супергруппа
        bigInt(0).subtract(n).toString() // обычная группа
      ];
    }
    try {
      const entity = await this.client.getEntity(ref);
      return [String(utils.getPeerId(entity))];
    } catch (e) {
      console.log('Не удалось найти чат', ref, e.errorMessage || e.message);
      return null;
    }
  }

  async rebuildWatched() {
    const next = new Set();
    for (const ref of this.user.chats) {
      let ids = this.resolvedRefs.get(ref);
      if (!ids) {
        ids = await this.resolveChatIds(ref);
        if (ids) this.resolvedRefs.set(ref, ids);
      }
      if (ids) ids.forEach((id) => next.add(id));
    }
    this.watched = next;
    console.log(`[user ${this.user.id}] слушаю чатов: ${this.user.chats.length} (id: ${this.watched.size})`);
  }

  ensureWatched() {
    const sig = this.user.chats.join('|');
    const stale = Date.now() - this.watchedAt > 5 * 60 * 1000;
    if (!this.refreshing && (sig !== this.watchedSig || stale)) {
      this.watchedSig = sig;
      this.watchedAt = Date.now();
      this.refreshing = this.rebuildWatched()
        .catch((e) => console.log('watched refresh error', e.message))
        .finally(() => { this.refreshing = null; });
    }
    return this.refreshing || Promise.resolve();
  }

  // ---------- разбор входящих ----------

  getReplyToId(msg) {
    return msg.replyToMsgId ?? msg.replyTo?.replyToMsgId ?? msg.replyToMessageId ?? null;
  }

  getRealReplyToId(msg) {
    const rt = msg.replyTo;
    if (rt?.forumTopic && !rt.replyToTopId) return null;
    return this.getReplyToId(msg);
  }

  async getAddressee(msg, chatId, realReplyToId) {
    if (!realReplyToId) return 'none';
    const key = `${chatId}_${realReplyToId}`;
    // «Нам» — только если это ответ на сообщение, которое отправил ВЗ-модуль.
    // Обычные исходящие сообщения аккаунта (человек пишет с телефона) сюда не попадают.
    return (this.hasOwnPost(key) || this.contexts.has(key)) ? 'me' : 'other';
  }

  async parseOffer(text, isReplyToOwnPost) {
    const direct = parser.parseVzMessage(text, isReplyToOwnPost);
    if (direct) return { parsed: direct, via: null };

    const ref = parser.parseMessageLink(text);
    if (!ref) return null;

    try {
      const [linked] = await this.client.getMessages(ref.peer, { ids: [ref.id] });
      if (!linked) return null;
      const parsed = parser.parseVzMessage(parser.messageToText(linked), false);
      return parsed ? { parsed, via: ref.link } : null;
    } catch (e) {
      console.log('linked message error', ref.link, e.errorMessage || e.message);
      return null;
    }
  }

  async tapAndReply(ctx, chatId, replyToMsgId, replyText) {
    try {
      const result = await this.tapper.tap(ctx.link, ctx.username, ctx.count || this.user.defaultVotes);
      await this.client.sendMessage(chatId, { message: replyText, replyTo: replyToMsgId });
      await this.log(`✅ Тап выполнен: @${ctx.username} | ${ctx.link} | каналов: ${result.total} | чат: ${chatId}`);
      await this.postDeal(ctx, 'done', `🎯 Тапнуто каналов: ${result.total}`);
      await this.proposer.onDone(ctx, result);
    } catch (e) {
      await this.log(`❌ Ошибка тапа: ${e.message}`);
      await this.postDeal(ctx, 'failed', `⚠️ ${e.message}`);
      await this.proposer.onFailed(ctx, e);
    }
  }

  async onMessage(event) {
    const msg = event.message;
    if (!msg || msg.out || !this.running) return;

    // Служебные сообщения Telegram (777000): коды входа, оповещения о новых
    // сессиях/входах, о завершении сессий и т.п. Ловим их сразу, а не только
    // по запросу /login_code — иначе код теряется среди других уведомлений и
    // /login_code потом показывает не тот (старый), что реально нужен.
    if (String(msg.chatId) === '777000') {
      const text = msg.text || msg.message || '';
      if (text) {
        await this.log(`📨 Telegram (777000): ${text}`);
        await this.notify(`📨 Telegram (777000):\n\n${text}`);
      }
      return;
    }

    await this.ensureWatched();
    const chatId = msg.chatId;
    if (!this.watched.has(String(chatId))) return;

    await this.proposer.observe(msg, String(chatId));          // копит кандидатов для предложений
    if (await this.proposer.handleReply(msg, chatId)) return;  // ответ на наше предложение

    const text = parser.messageToText(msg);
    const replyToId = this.getReplyToId(msg);
    const ctxKey = replyToId ? `${chatId}_${replyToId}` : null;

    // 1) Ответ на наше "сообщите" — тапаем
    if (ctxKey) {
      const ctx = this.contexts.get(ctxKey);
      if (ctx) {
        const t = norm(text);
        const confirm = norm(this.user.confirmKeyword);
        let replyText = null;

        if (AFTER_YOU_RE.test(t)) {
          replyText = this.user.afterYouReply || AFTER_YOU_REPLY_DEFAULT;
        } else if (confirm && t.includes(confirm)) {
          replyText = this.user.doneKeyword;
        } else if (TAP_RE.test(t)) {
          replyText = this.user.doneKeyword;
        }

        if (replyText) {
          this.contexts.delete(ctxKey); // сначала удаляем, чтобы не тапнуть дважды
          await this.tapAndReply(ctx, chatId, msg.id, replyText);
          return;
        }
      }
    }

    // 1.5) Просто "тап" в ответ на любое сообщение — сами ищем в нём ссылку и юз
    if (replyToId && TAP_ONLY_RE.test(norm(text))) {
      try {
        const replied = await msg.getReplyMessage();
        const repliedText = replied ? parser.messageToText(replied) : '';
        const parsed = parser.parseVzMessage(repliedText, true);
        if (parsed) {
          const ctx = {
            chatId: String(chatId),
            chatTitle: await this.chatTitle(chatId),
            authorId: replied.senderId ? String(replied.senderId) : null,
            username: parsed.username,
            link: parsed.link,
            count: parsed.count || this.user.defaultVotes,
            offerLink: null,
            agreedAt: Date.now(),
            dealMsgId: null
          };
          await this.tapAndReply(ctx, chatId, msg.id, this.user.doneKeyword);
          return;
        }
      } catch (e) {
        console.log('reply-tap error', e.errorMessage || e.message);
      }
    }

    // 2) Новое предложение вз
    if (!/(?:t\.me|telegram\.me)\//i.test(text)) return;
    const addressee = await this.getAddressee(msg, chatId, this.getRealReplyToId(msg));
    if (addressee === 'other') return;
    if (addressee === 'none' && this.user.answerGeneralOffers === false) return;

    const offer = await this.parseOffer(text, addressee === 'me');
    if (!offer) return;

    const { parsed, via } = offer;

    if (this.tapper) {
      try {
        if (await this.tapper.alreadyTapped(parsed.link)) {
          console.log(`[user ${this.user.id}] пропустил повтор — уже тапали ${parsed.link}`);
          return;
        }
      } catch (e) {
        console.log('alreadyTapped check error', e.message);
      }
    }

    try {
      const replyMsg = await this.client.sendMessage(chatId, {
        message: this.user.confirmKeyword,
        replyTo: msg.id
      });

      const ctx = {
        chatId: String(chatId),
        chatTitle: await this.chatTitle(chatId),
        authorId: msg.senderId ? String(msg.senderId) : null,
        username: parsed.username,
        link: parsed.link,
        count: parsed.count || this.user.defaultVotes,
        offerLink: via || null,
        agreedAt: Date.now(),
        dealMsgId: null
      };

      this.proposer.onAgreed(ctx, msg);

      // карточка договора сразу, потом она же отредактируется при выполнении
      ctx.dealMsgId = await this.postDeal(ctx, 'agreed', '⏳ Ждём подтверждения партнёра');

      this.contexts.set(`${chatId}_${replyMsg.id}`, ctx);
      this.addOwnPost(`${chatId}_${replyMsg.id}`);
      await this.log(`💬 Ответил "${this.user.confirmKeyword}" в чат ${chatId} на предложение @${parsed.username} | ${parsed.link}${via ? ` (из ${via})` : ''}`);
    } catch (e) {
      console.log('reply error', e.message);
    }
  }

  // ---------- рассылка ----------

  async broadcast(text, entities, file) {
    const client = this.requireClient();
    const formattingEntities = (entities || []).map((e) => new Api.MessageEntityCustomEmoji({
      offset: e.offset,
      length: e.length,
      documentId: bigInt(e.documentId)
    }));
    const chats = [...this.user.chats];
    let sent = 0;
    const errors = [];
    await this.primeDialogs();

    for (let i = 0; i < chats.length; i++) {
      try {
        const peer = await this.resolvePeer(chats[i]);
        const sentMsg = file
          ? await client.sendFile(peer, { file, caption: text, formattingEntities })
          : await client.sendMessage(peer, { message: text, formattingEntities });
        this.addOwnPost(`${sentMsg.chatId}_${sentMsg.id}`, false);
        sent++;
      } catch (e) {
        const reason = e.errorMessage || e.message;
        console.log('post error', chats[i], reason);
        errors.push(`${chats[i]}: ${reason}`);
        this.peers.delete(chats[i]); // вдруг протух кэш
      }
      if (i < chats.length - 1) await sleep(1500 + Math.random() * 1500);
    }
    this.users.save();
    return { sent, total: chats.length, errors };
  }

  async runAutopost() {
    const ap = this.user.autopost;
    this.autopostBusy = true;
    try {
      const { sent, total } = await this.broadcast(ap.text, ap.entities);
      ap.lastAt = Date.now();
      ap.lastResult = `${sent}/${total}`;
      this.users.save();
      return { sent, total };
    } finally {
      this.autopostBusy = false;
    }
  }

  async autopostTick() {
    const ap = this.user.autopost;
    if (!this.running || !ap.enabled || this.autopostBusy || !ap.text || !ap.intervalMin) return;
    if (Date.now() < (ap.nextAt || 0)) return;

    ap.nextAt = Date.now() + ap.intervalMin * 60000;
    this.users.save();
    try {
      const { sent, total } = await this.runAutopost();
      ap.nextAt = Date.now() + ap.intervalMin * 60000;
      this.users.save();
      await this.log(`📣 Автопост: разослано в ${sent} из ${total} чатов`);
    } catch (e) {
      await this.log(`❌ Ошибка автопоста: ${e.message}`);
    }
  }
}

// --- менеджер сессий: по одной на пользователя ---
class SessionManager {
  constructor(config, users) {
    this.config = config;
    this.users = users;
    this.map = new Map();
    this.bot = null;
  }

  setBot(bot) {
    this.bot = bot;
  }

  // Возвращает сессию пользователя, создавая её при необходимости.
  get(userId) {
    const key = String(userId);
    let s = this.map.get(key);
    if (!s) {
      const user = this.users.ensure(key);
      s = new UserSession(user, this.config, this.users, this.bot);
      this.map.set(key, s);
    }
    s.bot = this.bot;
    return s;
  }

  async drop(userId) {
    const key = String(userId);
    const s = this.map.get(key);
    if (s) {
      await s.stop();
      this.map.delete(key);
    }
  }

  // Поднимает сессии всех, кто уже авторизован
  async startAll() {
    for (const user of this.users.all()) {
      if (!user.session) continue;
      try {
        await this.get(user.id).start();
      } catch (e) {
        console.log(`[user ${user.id}] не удалось поднять сессию:`, e.message);
      }
    }
  }

  tickAll() {
    for (const s of this.map.values()) {
      s.autopostTick().catch((e) => console.log('autopost tick error', e.message));
      s.proposer.tick().catch((e) => console.log('offers tick error', e.message));
    }
  }
}

module.exports = { UserSession, SessionManager };
