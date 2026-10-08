const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { Api } = require('telegram');
const { computeCheck } = require('telegram/Password');
const events = require('telegram/events');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Один экземпляр = один аккаунт одного пользователя бота.
class Userbot {
  constructor(user, config, users) {
    this.user = user;
    this.config = config;
    this.users = users;
    this.client = null;
    this.phoneCodeHash = null;
  }

  get apiId() {
    return this.user.apiId || this.config.data.apiId;
  }

  get apiHash() {
    return this.user.apiHash || this.config.data.apiHash;
  }

  init() {
    if (!this.apiId || !this.apiHash) throw new Error('Не заданы apiId/apiHash');
    this.client = new TelegramClient(
      new StringSession(this.user.session || ''),
      this.apiId,
      this.apiHash,
      { connectionRetries: 5, autoReconnect: true }
    );
    return this.client;
  }

  async connect() {
    if (!this.client) this.init();
    if (!this.client.connected) await this.client.connect();
    return this.client;
  }

  async sendCode(phone) {
    await this.connect();
    const result = await this.client.sendCode({ apiId: this.apiId, apiHash: this.apiHash }, phone);
    this.phoneCodeHash = result.phoneCodeHash;
    this.user.phone = phone;
    this.users.save();
    return result;
  }

  async signIn(phone, code) {
    const cleanCode = String(code).replace(/\D/g, '');
    if (!this.phoneCodeHash) throw new Error('Сначала /login <номер телефона>');
    try {
      await this.client.invoke(new Api.auth.SignIn({
        phoneNumber: phone,
        phoneCode: cleanCode,
        phoneCodeHash: this.phoneCodeHash
      }));
    } catch (e) {
      if (e.errorMessage === 'SESSION_PASSWORD_NEEDED') return { twofa: true };
      throw e;
    }
    this.saveSession();
    return { twofa: false };
  }

  async checkPassword(password) {
    const pwd = await this.client.invoke(new Api.account.GetPassword());
    const computed = await computeCheck(pwd, password);
    await this.client.invoke(new Api.auth.CheckPassword({ password: computed }));
    this.saveSession();
  }

  // ---------- вход по QR-коду ----------
  // Работает по документации Telegram (auth.exportLoginToken): показываем токен
  // как QR, ждём UpdateLoginToken (или истечения токена ~30 с), затем снова
  // зовём exportLoginToken — если QR отсканирован, придёт LoginTokenSuccess.
  //
  // onQr({ token: Buffer, url, expires }) — вызывается на каждый новый QR.
  // isCancelled() — проверка отмены. Возвращает { status }:
  //   'ok' | 'twofa' (дальше /password) | 'timeout' | 'cancelled'
  async loginWithQr({ onQr, isCancelled = () => false, timeoutMs = 5 * 60 * 1000 }) {
    await this.connect();

    let wake = null;
    const handler = (update) => {
      if (update && update.className === 'UpdateLoginToken' && wake) wake();
    };
    let registered = false;
    if (events.Raw) {
      try {
        this.client.addEventHandler(handler, new events.Raw({}));
        registered = true;
      } catch (e) {
        console.log('qr: не смог повесить обработчик апдейтов, жду по таймеру:', e.message);
      }
    }

    const exportToken = () =>
      this.client.invoke(new Api.auth.ExportLoginToken({
        apiId: this.apiId,
        apiHash: this.apiHash,
        exceptIds: []
      }));

    const finish = () => {
      this.saveSession();
      return { status: 'ok' };
    };

    const deadline = Date.now() + timeoutMs;
    try {
      while (Date.now() < deadline) {
        if (isCancelled()) return { status: 'cancelled' };

        let result;
        try {
          result = await exportToken();
        } catch (e) {
          if (e.errorMessage === 'SESSION_PASSWORD_NEEDED') return { status: 'twofa' };
          if (e.errorMessage && e.errorMessage.startsWith('FLOOD_WAIT')) {
            await sleep((e.seconds || 5) * 1000);
            continue;
          }
          throw e;
        }

        if (result instanceof Api.auth.LoginTokenSuccess) return finish();

        // аккаунт живёт в другом дата-центре — переключаемся и импортируем токен
        if (result instanceof Api.auth.LoginTokenMigrateTo) {
          await this.client._switchDC(result.dcId);
          try {
            const migrated = await this.client.invoke(new Api.auth.ImportLoginToken({ token: result.token }));
            if (migrated instanceof Api.auth.LoginTokenSuccess) return finish();
          } catch (e) {
            if (e.errorMessage === 'SESSION_PASSWORD_NEEDED') return { status: 'twofa' };
            throw e;
          }
          continue;
        }

        if (!(result instanceof Api.auth.LoginToken)) {
          throw new Error('Неожиданный ответ exportLoginToken: ' + (result && result.className));
        }

        const b64url = Buffer.from(result.token).toString('base64')
          .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        await onQr({ token: result.token, url: `tg://login?token=${b64url}`, expires: result.expires });

        // ждём скана (апдейт) либо почти до истечения токена; границы — на случай сдвига часов
        const left = result.expires * 1000 - Date.now() - 3000;
        const waitMs = Math.min(25000, Math.max(5000, left));
        await new Promise((resolve) => {
          const t = setTimeout(resolve, waitMs);
          wake = () => { clearTimeout(t); resolve(); };
        });
        wake = null;
      }
      return { status: 'timeout' };
    } finally {
      wake = null;
      if (registered) {
        try { this.client.removeEventHandler(handler, new events.Raw({})); } catch {}
      }
    }
  }

  saveSession() {
    this.user.session = this.client.session.save();
    this.users.save();
  }

  async isAuthorized() {
    if (!this.client) return false;
    try {
      await this.client.getMe();
      return true;
    } catch {
      return false;
    }
  }

  async logout() {
    try {
      if (this.client && this.client.connected) {
        await this.client.invoke(new Api.auth.LogOut());
      }
    } catch (e) {
      console.log('logout error', e.errorMessage || e.message);
    }
    try {
      if (this.client) await this.client.disconnect();
    } catch {}
    this.client = null;
    this.phoneCodeHash = null;
    this.user.session = '';
    this.users.save();
  }

  async disconnect() {
    try {
      if (this.client) await this.client.disconnect();
    } catch {}
    this.client = null;
  }
}

module.exports = Userbot;
