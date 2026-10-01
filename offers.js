const { utils } = require('telegram');
const parser = require('./parser');

// Проактивные предложения ВЗ. Отдельный модуль: пока /offer не включён и нет
// отправленных предложений, бот работает ровно как раньше.
//
// Последовательность:
//   1) бот отвечает человеку в чате: "вз? <наша ссылка> @наш_юз"
//   2) отказ / болтовня  -> игнорируем
//      согласие (вз / сообщите / давайте / сейчас тап / тап после вас ...) ->
//      3) бот САМ ищет в чате голосование этого человека (его пост со ссылкой и @юз)
//      4) тапает его пост, 5) отвечает в чат и сообщает вам (личка + канал договоров)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е');
const HOUR = 60 * 60 * 1000;

const DEFAULT_TEXT = 'вз? {link} @{user}';
const ASK_LINK_TEXT = 'Не нашёл ваш пост с голосованием в чате — пришлите, пожалуйста, ссылку на него 🙏';
const MIN_INTERVAL_MIN = 10;
const MAX_INTERVAL_MIN = 7 * 24 * 60;
const MAX_AGE_MS = 25 * 60 * 1000; // предлагаем только тем, кто писал не позже 25 минут назад (позже голосование могло уже закончиться / набрать нужное число голосов)
const SCAN_MAX_AGE_MS = MAX_AGE_MS; // то же окно и при перечитывании истории чата (/offer now, периодический цикл)
const COOLDOWN_MS = 24 * HOUR; // пауза между повторными предложениями одному человеку
const MAX_OFFERS_PER_PERSON = 3;
const AGREED_TTL_MS = 3 * 24 * HOUR; // "договорились, но не тапнули" считается ВЗ 3 суток
const OFFERMSG_TTL_MS = 3 * 24 * HOUR;
const MAX_OFFERMSGS = 300;
const SCAN_CHATS = 6;
const SCAN_LIMIT = 40;
const FIND_LIMIT = 300; // сколько последних сообщений чата просматриваем в поисках голосования
const MAX_PER_CHAT = 2;
const MAX_POOL = 1000;

// согласие: вз / сообщите / давайте / сейчас тап / тап после вас + типичные варианты
const AGREE_RE = /(?<![а-яa-z])(?:вз|взаимк\S*|взаимн\S*|сообщите|сообщи|давай(?:те)?|погнали|го|ок|окей|да|ага|согласен|согласна|согласны|тап\S*)(?![а-яa-z])|\+/;
// отказ
const REFUSE_RE = /(?<![а-яa-z])(?:не|нет|неа|ноуп|no|nope|пас|отказ\S*|отказываюсь|неинтересно)(?![а-яa-z])/;
// "уже тапал", "уже взшались", "уже вз", "уже делали" и т.п. — вз уже был, просто не через нас
const ALREADY_RE = /(?<![а-яa-z])уже(?![а-яa-z])\s*(?:\S+\s+){0,2}(?:тап\S*|вз\S*|взаимн\S*|взаимк\S*|делали|сделали|было)|(?<![а-яa-z])(?:тапал\S*|тапнул\S*|взшал\S*|взшлись|взялись)(?![а-яa-z])/;
const AFTER_YOU_RE = /тап\S*\s+после\s+вас/;
// человек уже занят своим вз/тапом ("тап", "тап сообщите", "вз", "взаимка"...) —
// не считаем его "новым" кандидатом, иначе бот лезет со своим предложением
// прямо в чужую переписку про тап
const BUSY_RE = /(?<![а-яa-z])(?:тап\S*|вз|взаимн\S*|взаимк\S*|сообщите|сообщи)(?![а-яa-z])/;

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

// Публичные методы, вызываемые из основной логики (observe / handleReply / onAgreed /
// onDone / onFailed / tick), не бросают исключений наружу.
class Proposer {
  constructor(session) {
    this.s = session;
    this.pool = new Map(); // authorId -> последнее сообщение человека (кандидат)
    this.cursor = 0;
    this.busy = false;
    this.meId = null;
    this.s.users.get(this.s.user.id); // дописать новые поля в карточку, если их ещё нет
  }

  get user() { return this.s.user; }
  get cfg() { return this.s.user.offers; }

  // ---------- партнёры ----------

  markPartner(authorId, username, status) {
    const now = Date.now();
    const p = this.user.partners;
    const upd = (map, key) => {
      const prev = map[key];
      // "done" перекрывает всё; иначе если новый или прошлый статус "refused" — держим refused
      const finalStatus = (status === 'done' || (prev && prev.status === 'done'))
        ? 'done'
        : (status === 'refused' || (prev && prev.status === 'refused')) ? 'refused' : status;
      map[key] = { status: finalStatus, at: now };
    };
    if (authorId) upd(p.ids, String(authorId));
    if (username) upd(p.names, String(username).replace(/^@/, '').toLowerCase());
  }

  isPartner(c, now) {
    const p = this.user.partners;
    const ok = (rec) => rec && (rec.status === 'done' || rec.status === 'refused' || now - rec.at < AGREED_TTL_MS);
    return !!(ok(p.ids[c.authorId]) || (c.username && ok(p.names[c.username])));
  }

  // ---------- кандидаты ----------

  async consider(m, chatKey, maxAgeMs = MAX_AGE_MS) {
    if (!m || m.out || m.action || !m.senderId) return;
    const authorId = String(m.senderId);
    if (authorId.startsWith('-') || authorId === this.meId) return; // каналы/чаты и мы сами

    // сообщение похоже на чужой тап/вз в процессе ("тап", "тап сообщите", "вз"...) —
    // человек явно занят, не считаем его свежим кандидатом. НО: собственный пост-
    // приглашение («вз? ссылка @юз») тоже почти всегда содержит слово "вз" —
    // если сообщение реально парсится как пост со ссылкой и юзом, это не "занятость",
    // а ровно то, что мы ищем, так что busy-фильтр в этом случае не применяем.
    const t = norm(parser.messageToText(m));
    const looksLikeOwnOffer = !!parser.parseVzMessage(t);
    if (!looksLikeOwnOffer && (BUSY_RE.test(t) || AFTER_YOU_RE.test(t))) return;

    let sender = m.sender;
    if (!sender) {
      try { sender = await m.getSender(); } catch {}
    }
    if (!sender || sender.className !== 'User' || sender.bot || sender.deleted || sender.self) return;

    const ts = m.date ? m.date * 1000 : Date.now();
    if (Date.now() - ts > maxAgeMs) return;
    const prev = this.pool.get(authorId);
    if (prev && prev.at >= ts) return;

    this.pool.set(authorId, {
      authorId,
      chatKey,
      msgId: m.id,
      at: ts,
      maxAgeMs,
      username: sender.username ? sender.username.toLowerCase() : null
    });
    if (this.pool.size > MAX_POOL) this.trimPool();
  }

  trimPool() {
    const now = Date.now();
    for (const [k, c] of this.pool) if (now - c.at > (c.maxAgeMs || MAX_AGE_MS)) this.pool.delete(k);
    if (this.pool.size > MAX_POOL) {
      const sorted = [...this.pool.entries()].sort((a, b) => a[1].at - b[1].at);
      for (const [k] of sorted.slice(0, this.pool.size - MAX_POOL)) this.pool.delete(k);
    }
  }

  observe(msg, chatKey) {
    if (!this.cfg.enabled) return Promise.resolve();
    return this.consider(msg, chatKey).catch(() => {});
  }

  eligible(c, now) {
    if (now - c.at > (c.maxAgeMs || MAX_AGE_MS)) return false;
    if (this.isPartner(c, now)) return false;
    const off = this.user.offered[c.authorId];
    if (off) {
      if (off.n >= MAX_OFFERS_PER_PERSON) return false;
      if (now - off.at < COOLDOWN_MS) return false;
    }
    return true;
  }

  candidatesNow() {
    const now = Date.now();
    let n = 0;
    for (const c of this.pool.values()) if (this.eligible(c, now)) n++;
    return n;
  }

  async scan() {
    const chats = this.user.chats;
    if (!chats.length) return;
    const client = this.s.requireClient();
    const n = Math.min(SCAN_CHATS, chats.length);
    for (let i = 0; i < n; i++) {
      const ref = chats[this.cursor++ % chats.length];
      try {
        const peer = await this.s.resolvePeer(ref);
        const chatKey = String(utils.getPeerId(peer));
        const msgs = await client.getMessages(peer, { limit: SCAN_LIMIT });
        for (const m of msgs) await this.consider(m, chatKey, SCAN_MAX_AGE_MS);
      } catch (e) {
        console.log(`[user ${this.user.id}] offers scan`, ref, e.errorMessage || e.message);
      }
      await sleep(1500);
    }
  }

  pick(limit) {
    const now = Date.now();
    const byChat = new Map();
    for (const c of this.pool.values()) {
      if (!this.eligible(c, now)) continue;
      if (!byChat.has(c.chatKey)) byChat.set(c.chatKey, []);
      byChat.get(c.chatKey).push(c);
    }
    for (const list of byChat.values()) list.sort((a, b) => b.at - a.at);

    const picks = [];
    for (let round = 0; round < MAX_PER_CHAT && picks.length < limit; round++) {
      for (const list of byChat.values()) {
        if (picks.length >= limit) break;
        if (list[round]) picks.push(list[round]);
      }
    }
    return picks;
  }

  render() {
    const cfg = this.cfg;
    return (cfg.text || DEFAULT_TEXT)
      .replace(/\{link\}/g, cfg.link)
      .replace(/\{user\}/g, String(cfg.username).replace(/^@/, ''))
      .replace(/\{count\}/g, String(cfg.count || this.user.defaultVotes));
  }

  pruneOfferMsgs() {
    const msgs = this.user.offerMsgs;
    const now = Date.now();
    for (const [k, v] of Object.entries(msgs)) if (now - v.at > OFFERMSG_TTL_MS) delete msgs[k];
    const keys = Object.keys(msgs);
    if (keys.length > MAX_OFFERMSGS) {
      keys.sort((a, b) => msgs[a].at - msgs[b].at)
        .slice(0, keys.length - MAX_OFFERMSGS)
        .forEach((k) => delete msgs[k]);
    }
  }

  // ---------- 1) цикл предложений ----------

  async cycle({ notify = true } = {}) {
    const cfg = this.cfg;
    if (this.busy) throw new Error('Цикл предложений уже идёт');
    if (!cfg.link || !cfg.username) throw new Error('Не задан пост: /offer set <ссылка> <@юз>');
    if (!this.user.chats.length) throw new Error('Нет вз-чатов');

    this.busy = true;
    const result = { sent: 0, planned: 0, errors: [], list: [], stopped: null };
    try {
      const client = this.s.requireClient();
      if (!this.meId) this.meId = String((await client.getMe()).id);
      await this.s.primeDialogs();
      this.pruneOfferMsgs();
      await this.scan();

      const picks = this.pick(cfg.perCycle);
      result.planned = picks.length;
      const text = this.render();

      for (let i = 0; i < picks.length; i++) {
        const c = picks[i];
        try {
          const peer = await this.s.resolvePeer(c.chatKey);
          const sent = await client.sendMessage(peer, { message: text, replyTo: c.msgId });
          const key = `${sent.chatId}_${sent.id}`;
          this.s.addOwnPost(key, false);
          this.user.offerMsgs[key] = { authorId: c.authorId, at: Date.now(), handled: [], ask: false };
          const prev = this.user.offered[c.authorId];
          this.user.offered[c.authorId] = {
            n: (prev ? prev.n : 0) + 1,
            at: Date.now(),
            username: c.username,
            chatKey: String(sent.chatId),
            key
          };
          this.pool.delete(c.authorId);
          result.sent++;
          result.list.push(c);
          this.s.users.save();
        } catch (e) {
          const reason = e.errorMessage || e.message;
          result.errors.push(`${c.username ? '@' + c.username : c.authorId}: ${reason}`);
          this.pool.delete(c.authorId);
          if (/PEER_FLOOD|FLOOD_WAIT|USER_DEACTIVATED|AUTH_KEY/i.test(reason)) {
            result.stopped = reason;
            break;
          }
        }
        if (i < picks.length - 1) await sleep(20000 + Math.random() * 20000);
      }

      cfg.lastAt = Date.now();
      cfg.lastResult = `${result.sent}/${result.planned}`;
      cfg.stats.offered += result.sent;
      if (result.stopped && /PEER_FLOOD/i.test(result.stopped)) cfg.enabled = false; // спам-ограничение аккаунта
      this.s.users.save();

      await this.report(result, notify);
      return result;
    } finally {
      this.busy = false;
    }
  }

  async report(result, notify) {
    try {
      const lines = [`📤 Предложения ВЗ: отправлено ${result.sent} из ${result.planned}`];
      for (const c of result.list.slice(0, 15)) {
        const title = await this.s.chatTitle(c.chatKey);
        lines.push(`• ${c.username ? '@' + c.username : 'id ' + c.authorId} — ${title}`);
      }
      if (result.errors.length) {
        lines.push(`\n⚠️ Не ушло (${result.errors.length}):`, ...result.errors.slice(0, 10));
      }
      if (result.stopped) {
        lines.push(`\n🛑 Цикл остановлен: ${result.stopped}` +
          (/PEER_FLOOD/i.test(result.stopped) ? '\nTelegram ограничил отправку — предложения выключены. Включите позже: /offer on' : ''));
      }
      if (!result.planned) lines.push('Новых кандидатов пока нет.');
      const text = lines.join('\n');
      await this.s.log(text);
      if (notify && this.cfg.notify && (result.sent || result.errors.length)) await this.s.notify(text);
    } catch (e) {
      console.log('offers report error', e.message);
    }
  }

  async tick() {
    try {
      const cfg = this.cfg;
      if (!this.s.running || !cfg.enabled || this.busy) return;
      if (Date.now() < (cfg.nextAt || 0)) return;
      cfg.nextAt = Date.now() + cfg.intervalMin * 60000;
      this.s.users.save();
      try {
        await this.cycle();
      } catch (e) {
        await this.s.log(`❌ Ошибка предложений ВЗ: ${e.message}`);
      }
      cfg.nextAt = Date.now() + cfg.intervalMin * 60000;
      this.s.users.save();
    } catch (e) {
      console.log('offers tick error', e.message);
    }
  }

  // ---------- 2) реакция на ответ человека ----------

  // Вызывается из onMessage для каждого входящего сообщения.
  // true — сообщение относится к нашему предложению и обработано (дальше старая логика не нужна).
  async handleReply(msg, chatId) {
    let rec = null;
    try {
      if (!this.cfg.enabled) return false; // /offer off — не реагируем даже на уже отправленные ранее предложения
      if (!msg || msg.out || !msg.senderId) return false;
      const replierId = String(msg.senderId);
      if (replierId.startsWith('-')) return false;

      const offerMsgs = this.user.offerMsgs;
      if (!offerMsgs || !Object.keys(offerMsgs).length) return false;

      const text = parser.messageToText(msg);
      const t = norm(text);
      const rid = this.s.getRealReplyToId(msg);
      if (!rid) return false; // реагируем ТОЛЬКО на настоящий reply на наше сообщение

      rec = offerMsgs[`${chatId}_${rid}`] || null;
      if (!rec) return false;

      // отказ ("нет", "отказ"...) или "уже тапал / уже взшались" — не действуем,
      // и больше НИКОГДА не предлагаем этому человеку (пока не /offer forget)
      if (REFUSE_RE.test(t) || ALREADY_RE.test(t)) {
        const off = this.user.offered[replierId];
        this.markPartner(replierId, off ? off.username : null, 'refused');
        rec.handled = rec.handled || [];
        if (!rec.handled.includes(replierId)) rec.handled.push(replierId);
        this.s.users.save();
        await this.s.log(`🚫 ${ALREADY_RE.test(t) ? 'Уже был вз/тап' : 'Отказ'} от ${replierId} в чате ${chatId} — больше не предлагаем`);
        return true;
      }

      // ссылка на свой пост прямо в ответе — это тоже согласие
      const own = parser.parseVzMessage(text);
      const agree = !!own || (AGREE_RE.test(t) && !REFUSE_RE.test(t));
      if (!agree) return false; // болтовня не по теме — игнорируем

      rec.handled = rec.handled || [];
      if (rec.handled.includes(replierId)) return true; // этого человека уже обработали
      rec.handled.push(replierId);
      this.s.users.save();

      await this.acceptAgreement(msg, chatId, replierId, own, t, rec);
      return true;
    } catch (e) {
      console.log(`[user ${this.user.id}] offers handleReply error`, e.errorMessage || e.message);
      return !!rec;
    }
  }

  // ищем в чате голосование человека: его сообщение со ссылкой на пост и @юзом
  async findVote(peer, authorId) {
    const client = this.s.requireClient();
    const scan = async (opts) => {
      let msgs = [];
      try {
        msgs = await client.getMessages(peer, opts);
      } catch (e) {
        console.log('offers findVote', e.errorMessage || e.message);
        return null;
      }
      for (const m of msgs) { // от новых к старым
        if (!m || m.out || String(m.senderId) !== authorId) continue;
        const text = parser.messageToText(m);
        if (!/(?:t\.me|telegram\.me)\//i.test(text)) continue;
        const offer = await this.s.parseOffer(text, false); // понимает и «вз? ссылка-на-сообщение»
        if (offer) return offer.parsed;
      }
      return null;
    };
    return (await scan({ limit: 40, fromUser: authorId })) || (await scan({ limit: FIND_LIMIT }));
  }

  async acceptAgreement(msg, chatId, replierId, own, t, rec) {
    const s = this.s;
    const client = s.requireClient();
    const peer = await s.resolvePeer(String(chatId));

    const parsed = own || await this.findVote(peer, replierId);

    if (!parsed) {
      if (rec.ask) rec.handled = rec.handled.filter((x) => x !== replierId); // дать ещё попытку со ссылкой
      if (!rec.ask) {
        // один раз просим прислать ссылку; ответ на этот вопрос тоже обрабатывается
        const ask = await client.sendMessage(peer, { message: ASK_LINK_TEXT, replyTo: msg.id });
        const key = `${ask.chatId}_${ask.id}`;
        this.user.offerMsgs[key] = { authorId: replierId, at: Date.now(), handled: [], ask: true };
        s.addOwnPost(key, false);
      }
      s.users.save();
      await s.log(`🔎 Согласие от ${replierId} в чате ${chatId}, но его голосование не найдено`);
      if (this.cfg.notify) await s.notify(`⚠️ Человек согласился на ВЗ (id ${replierId}), но я не нашёл его голосование в чате «${await s.chatTitle(chatId)}».${rec.ask ? '' : ' Попросил прислать ссылку.'}`);
      return;
    }

    if (s.tapper) {
      try {
        if (await s.tapper.alreadyTapped(parsed.link)) {
          await s.log(`⏭ Пропустил повтор — уже тапали этот пост: ${parsed.link}`);
          return;
        }
      } catch (e) {
        console.log('alreadyTapped check error', e.message);
      }
    }

    const ctx = {
      chatId: String(chatId),
      chatTitle: await s.chatTitle(chatId),
      authorId: replierId,
      username: parsed.username,
      link: parsed.link,
      count: parsed.count || this.user.defaultVotes,
      offerLink: null,
      agreedAt: Date.now(),
      dealMsgId: null,
      viaOffer: true
    };

    const replyText = AFTER_YOU_RE.test(t)
      ? (this.user.afterYouReply || 'тап, сообщите')
      : this.user.doneKeyword;

    ctx.dealMsgId = await s.postDeal(ctx, 'agreed', '⏳ Согласие на наше предложение, тапаю');
    this.markPartner(replierId, parsed.username, 'agreed');
    this.cfg.stats.agreed++;
    s.users.save();
    await s.log(`🤝 Согласие на наше предложение: ${replierId} → тапаю @${parsed.username} | ${parsed.link} | чат ${chatId}`);

    // тап → ответ в чат → карточка договора → уведомление (onDone / onFailed внутри)
    await s.tapAndReply(ctx, chatId, msg.id, replyText);
  }

  // ---------- хуки основной логики ----------

  // договорились по старой схеме (нам предложили, мы ответили)
  onAgreed(ctx, msg) {
    try {
      const rid = this.s.getReplyToId(msg);
      const key = rid ? `${ctx.chatId}_${rid}` : null;
      const off = ctx.authorId ? this.user.offered[ctx.authorId] : null;
      ctx.viaOffer = !!((key && this.user.offerMsgs[key]) || (off && Date.now() - off.at < 3 * 24 * HOUR));
      this.markPartner(ctx.authorId, ctx.username, 'agreed');
      if (ctx.viaOffer) this.cfg.stats.agreed++;
      this.s.users.save();
    } catch (e) {
      console.log('offers onAgreed error', e.message);
    }
  }

  async onDone(ctx, result) {
    try {
      this.markPartner(ctx.authorId, ctx.username, 'done');
      if (ctx.viaOffer) this.cfg.stats.done++;
      this.s.users.save();
      if (this.cfg.notify && (this.cfg.enabled || ctx.viaOffer)) {
        await this.s.notify(
          `✅ Тап выполнен${ctx.viaOffer ? ' (по нашему предложению)' : ''}\n` +
          `👤 @${ctx.username}\n🔗 ${ctx.link}\n🎯 Каналов: ${result && result.total}\n💬 ${ctx.chatTitle || ctx.chatId}`
        );
      }
    } catch (e) {
      console.log('offers onDone error', e.message);
    }
  }

  async onFailed(ctx, err) {
    try {
      if (this.cfg.notify && (this.cfg.enabled || ctx.viaOffer)) {
        await this.s.notify(`❌ Тап не удался: @${ctx.username}\n🔗 ${ctx.link}\n⚠️ ${err && err.message}`);
      }
    } catch (e) {
      console.log('offers onFailed error', e.message);
    }
  }

  // ---------- импорт истории из канала договоров ----------

  async syncFromDeals() {
    const target = this.user.dealsChannel;
    if (!target) throw new Error('Канал договоров не выбран (/deals_channel)');
    const client = this.s.requireClient();
    const peer = await this.s.resolvePeer(target);
    const names = this.user.partners.names;
    let count = 0;

    for await (const m of client.iterMessages(peer, { limit: 3000 })) {
      const t = m.message || '';
      const pm = t.match(/Партнёр:\s*@([A-Za-z0-9_]+)/);
      if (!pm) continue;
      const head = t.split('\n')[0];
      if (/ошибк/i.test(head)) continue;
      const status = /выполнен/i.test(head) ? 'done' : 'agreed';
      const key = pm[1].toLowerCase();
      const at = m.date ? m.date * 1000 : Date.now();
      const prev = names[key];
      names[key] = {
        status: status === 'done' || (prev && prev.status === 'done') ? 'done' : 'agreed',
        at: Math.max(at, prev ? prev.at : 0)
      };
      count++;
    }
    this.cfg.syncedAt = Date.now();
    this.s.users.save();
    return count;
  }

  statusText() {
    const c = this.cfg;
    const u = this.user;
    const doneNames = Object.values(u.partners.names).filter((x) => x.status === 'done').length;
    const doneIds = Object.values(u.partners.ids).filter((x) => x.status === 'done').length;
    const refusedNames = Object.values(u.partners.names).filter((x) => x.status === 'refused').length;
    const refusedIds = Object.values(u.partners.ids).filter((x) => x.status === 'refused').length;
    const lines = [
      `📤 Предложения ВЗ: ${c.enabled ? 'включены' : 'выключены'}`,
      `Что предлагаем: ${c.link ? c.link + ' @' + c.username : 'не задано (/offer set <ссылка> <@юз>)'}`,
      `Шаблон: ${c.text || DEFAULT_TEXT}`,
      `Частота: каждые ${fmtMinutes(c.intervalMin)}, до ${c.perCycle} чел. за цикл`,
      `Уведомления в личку: ${c.notify ? 'да' : 'нет'}`,
      `Кандидатов сейчас: ${this.candidatesNow()} (в памяти: ${this.pool.size})`,
      `Уже взшались: по юзам ${doneNames}, по id ${doneIds}`,
      `Отказались / уже было без нас: по юзам ${refusedNames}, по id ${refusedIds}`,
      `Всего: предложено ${c.stats.offered}, согласились ${c.stats.agreed}, тапнуто ${c.stats.done}`
    ];
    if (c.enabled && c.nextAt) lines.push(`Следующий цикл: через ${fmtMinutes((c.nextAt - Date.now()) / 60000)}`);
    if (c.lastAt) lines.push(`Прошлый цикл: ${fmtMinutes((Date.now() - c.lastAt) / 60000)} назад (${c.lastResult})`);
    return lines.join('\n');
  }
}

// ---------- команда /offer ----------

function registerOfferCommands(bot, users, sessions) {
  const U = (ctx) => users.get(ctx.from.id);
  const S = (ctx) => sessions.get(ctx.from.id);

  const HELP =
    'Как работает: бот предлагает ВЗ новым людям в чатах. Отказ — игнор. Согласие (вз / сообщите / давайте / сейчас тап / тап после вас) — бот сам находит голосование человека в чате, тапает и сообщает.\n\n' +
    'Команды:\n' +
    '/offer set <ссылка на ваш пост> <@юз> — что предлагаем\n' +
    '/offer on | off — включить / выключить\n' +
    '/offer now — запустить цикл прямо сейчас\n' +
    '/offer every <30м|2ч|1д> — частота (минимум ' + MIN_INTERVAL_MIN + ' мин)\n' +
    '/offer limit <1-15> — сколько человек за цикл\n' +
    '/offer text <шаблон> — свой текст ({link} {user} {count}), /offer text reset — сбросить\n' +
    '/offer notify on|off — уведомления в личку\n' +
    '/offer sync — подтянуть уже взшавшихся из канала договоров\n' +
    '/offer forget <@юз|id|all> — забыть, что с этим человеком уже был вз/отказ, и снова предлагать\n' +
    '/offer report — отчёт';

  bot.command('offer', async (ctx) => {
    const u = U(ctx);
    const s = S(ctx);
    const p = s.proposer;
    const cfg = u.offers;

    const body = ctx.message.text.replace(/^\/\S+\s*/, '');
    const m = body.match(/^(\S+)\s*([\s\S]*)$/);
    const sub = m ? m[1].toLowerCase() : '';
    const rest = m ? m[2].trim() : '';

    try {
      switch (sub) {
        case '':
        case 'status':
          return ctx.reply(p.statusText() + '\n\n' + HELP);

        case 'report':
          return ctx.reply(p.statusText());

        case 'set': {
          const parsed = parser.parseVzMessage(rest);
          if (!parsed) return ctx.reply('Формат: /offer set <ссылка на ваш пост> <@юз>\nНапример: /offer set https://t.me/mychannel/15 @myname');
          cfg.link = parsed.link;
          cfg.username = parsed.username;
          cfg.count = parsed.count || null;
          users.save();
          return ctx.reply(`✅ Предлагаем: ${cfg.link} @${cfg.username}\nСообщение будет: ${p.render()}`);
        }

        case 'text': {
          if (!rest) return ctx.reply(`Сейчас: ${cfg.text || DEFAULT_TEXT}\nСменить: /offer text <шаблон> (обязательны {link} и {user}, ещё можно {count})\nСбросить: /offer text reset`);
          if (rest.toLowerCase() === 'reset') {
            cfg.text = '';
            users.save();
            return ctx.reply('Шаблон сброшен на стандартный: ' + DEFAULT_TEXT);
          }
          if (!rest.includes('{link}') || !rest.includes('{user}')) return ctx.reply('В шаблоне должны быть {link} и {user}');
          if (rest.length > 500) return ctx.reply('Слишком длинно (максимум 500 символов)');
          cfg.text = rest;
          users.save();
          return ctx.reply('✅ Шаблон сохранён.' + (cfg.link ? '\nПример: ' + p.render() : ''));
        }

        case 'every': {
          if (!rest) return ctx.reply(`Формат: /offer every 30м | 2ч | 1д (минимум ${MIN_INTERVAL_MIN} мин)`);
          const minutes = parseInterval(rest.replace(/\s+/g, ''));
          if (!minutes) return ctx.reply('Не понял интервал. Примеры: 30м, 2ч, 1.5ч, 1д');
          if (minutes < MIN_INTERVAL_MIN) return ctx.reply(`Слишком часто: минимум ${MIN_INTERVAL_MIN} мин`);
          if (minutes > MAX_INTERVAL_MIN) return ctx.reply('Слишком редко: максимум 7 дней');
          cfg.intervalMin = minutes;
          if (cfg.enabled) cfg.nextAt = Date.now() + minutes * 60000;
          users.save();
          return ctx.reply(`Частота: каждые ${fmtMinutes(minutes)}`);
        }

        case 'limit': {
          const n = parseInt(rest, 10);
          if (!n || n < 1 || n > 15) return ctx.reply('Формат: /offer limit <число от 1 до 15>');
          cfg.perCycle = n;
          users.save();
          return ctx.reply(`За цикл — не больше ${n} человек`);
        }

        case 'notify': {
          const v = rest.toLowerCase();
          if (!['on', 'off', 'да', 'нет'].includes(v)) return ctx.reply('Формат: /offer notify on|off');
          cfg.notify = v === 'on' || v === 'да';
          users.save();
          return ctx.reply(`Уведомления в личку: ${cfg.notify ? 'да' : 'нет'}`);
        }

        case 'sync': {
          if (!s.running) return ctx.reply('Аккаунт не подключён — сначала /login <номер>');
          await ctx.reply('Читаю канал договоров…');
          const n = await p.syncFromDeals();
          return ctx.reply(`✅ Найдено договоров: ${n}. Эти люди больше не считаются «новыми».`);
        }

        case 'forget': {
          if (!rest) return ctx.reply('Формат: /offer forget <@юз|id|all> — забыть, что с этим человеком уже был вз/отказ, и снова предлагать');

          if (rest.toLowerCase() === 'all') {
            const count = Object.keys(u.partners.ids).length + Object.keys(u.partners.names).length;
            u.partners.ids = {};
            u.partners.names = {};
            u.offered = {};
            users.save();
            return ctx.reply(`🔄 Список «уже был вз / отказ» очищен (${count} записей) — бот снова будет предлагать всем.`);
          }

          const arg = rest.trim();
          let removed = 0;
          if (/^-?\d+$/.test(arg)) {
            if (u.partners.ids[arg]) { delete u.partners.ids[arg]; removed++; }
            if (u.offered[arg]) { delete u.offered[arg]; removed++; }
          } else {
            const uname = arg.replace(/^@/, '').toLowerCase();
            if (u.partners.names[uname]) { delete u.partners.names[uname]; removed++; }
            for (const [id, off] of Object.entries(u.offered)) {
              if (off.username === uname) { delete u.offered[id]; removed++; }
            }
          }
          users.save();
          return ctx.reply(removed ? `🔄 ${arg} снова доступен для предложения ВЗ` : `${arg} не найден в списке «уже был вз»`);
        }

        case 'on': {
          if (!s.running) return ctx.reply('Аккаунт не подключён — сначала /login <номер>');
          if (!cfg.link || !cfg.username) return ctx.reply('Сначала задайте, что предлагаем: /offer set <ссылка на пост> <@юз>');
          if (!u.chats.length) return ctx.reply('Нет вз-чатов (/add_chat)');
          if (!u.channels.length) return ctx.reply('Нет каналов для тапов (/add_channel) — нечем будет тапать в ответ');
          let synced = '';
          if (!cfg.syncedAt && u.dealsChannel) {
            try { synced = `\nИз канала договоров подтянуто: ${await p.syncFromDeals()}`; } catch (e) { console.log('offer sync error', e.message); }
          }
          cfg.enabled = true;
          cfg.nextAt = Date.now() + 30000;
          users.save();
          return ctx.reply(`✅ Предложения включены: каждые ${fmtMinutes(cfg.intervalMin)}, до ${cfg.perCycle} чел. за цикл. Первый цикл — через минуту.${synced}\nСогласившихся бот тапает сам, отчёты придут сюда.`);
        }

        case 'off':
          cfg.enabled = false;
          cfg.nextAt = null;
          users.save();
          return ctx.reply('⏹ Предложения ВЗ выключены полностью: новых циклов не будет, и на ответы по уже отправленным ранее предложениям бот тоже больше не реагирует. Ответы на чужие предложения (не наши) по-прежнему работают как раньше.');

        case 'now': {
          if (!s.running) return ctx.reply('Аккаунт не подключён — сначала /login <номер>');
          if (p.busy) return ctx.reply('Цикл уже идёт');
          await ctx.reply('Ищу, кому предложить… Отчёт пришлю сюда.');
          // в фоне: цикл идёт минуты, а обработчик команды в telegraf ограничен по времени
          p.cycle({ notify: false })
            .then((r) => ctx.reply(`Готово: отправлено ${r.sent} из ${r.planned}` +
              (r.errors.length ? `\nНе ушло: ${r.errors.slice(0, 10).join('; ')}` : '') +
              (r.planned ? '' : '\nНовых кандидатов нет — подождите, пока в чатах появятся новые люди.')))
            .catch((e) => ctx.reply(`Ошибка: ${e.errorMessage || e.message}`));
          return;
        }

        default:
          return ctx.reply(HELP);
      }
    } catch (e) {
      console.error('offer command error:', e);
      return ctx.reply(`Ошибка: ${e.errorMessage || e.message}`);
    }
  });
}

module.exports = { Proposer, registerOfferCommands };
