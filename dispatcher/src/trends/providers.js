// Провайдеры сбора (T09): откуда берутся посты. Их два, и переключаются они одной строкой в .env.
//
//   apify (ОСНОВНОЙ, решение клиента 07.09.2026) — собирает облачный актор Apify на аккаунте
//     клиента. Мы никуда не логинимся, cookie-сессий и прокси нет, бан-риска для аккаунта клиента
//     нет. Клиент платит Apify и сам вводит токен и id акторов при установке.
//
//   login (РЕЗЕРВ, вариант C) — логин ОСНОВНЫМ аккаунтом клиента. Оставлен точкой расширения на
//     случай, если Apify подорожает или сломается. Кода сбора здесь НЕТ: включать его без
//     страховок (резидентный прокси, постоянная cookie-сессия, 1 прогон/день, человекоподобный
//     темп) нельзя — это прямой бан-риск для основного аккаунта. Провайдер честно говорит, что
//     не настроен, вместо того чтобы делать вид, будто работает.
//
// Интерфейс провайдера: collect({sources, config, ...}) → { posts[], notes[], perPlatform[] }.
// Ошибка одной площадки не роняет прогон: она уходит в notes, а посты второй площадки собираются.

import { runActor, ApifyError } from './apify.js';
import { actorFor, buildActorInput, buildTargets, enabledPlatforms, limitsOf, sourceQueryFor } from './sources.js';
import { normalizeItems } from './normalize.js';

/** Поля, в которые акторы обычно кладут «а по какой ссылке/запросу это найдено». */
const SOURCE_HINT_FIELDS = ['inputUrl', 'sourceUrl', 'searchQuery', 'queryUrl', 'hashtag', 'searchTerm'];

export const apifyProvider = {
  name: 'apify',

  /** Готов ли провайдер работать: без токена смысла ходить нет. */
  available({ config }) {
    if (!config?.apifyToken) {
      return { ok: false, error: 'не задан APIFY_TOKEN в dispatcher/.env (см. trends/README.md)' };
    }
    return { ok: true };
  },

  async collect({ sources, config, fetchImpl, onLog = null }) {
    const limits = limitsOf(sources);
    const notes = [];
    const perPlatform = [];
    const posts = [];

    for (const { platform, cfg } of enabledPlatforms(sources)) {
      const actorId = actorFor(cfg, platform, config?.apifyActors);
      const targets = buildTargets(cfg, platform);
      if (!actorId || !targets.length) {
        notes.push(`${platform}: пропущено — не задан актор или цели`);
        perPlatform.push({ platform, count: 0, error: 'нет актора или целей' });
        continue;
      }

      const input = buildActorInput(cfg, targets, { postsPerSource: limits.postsPerSource });
      onLog?.(`[trends] ${platform}: актор ${actorId}, целей ${targets.length}`);

      try {
        const { items, runId } = await runActor({
          token: config.apifyToken,
          actorId,
          input,
          maxItems: limits.maxPostsPerRun,
          timeoutMs: config.apifyTimeoutMs,
          pollMs: config.apifyPollMs,
          baseUrl: config.apifyBaseUrl,
          fetchImpl,
          onLog,
        });

        const fresh = normalizeItems(items, {
          platform,
          map: cfg.map || {},
          resolveSource: (raw) => resolveSource(raw, targets),
        });
        fillSourceByAuthor(fresh, targets);

        posts.push(...fresh);
        perPlatform.push({ platform, count: fresh.length, actorId, runId });
        notes.push(`${platform}: собрано ${fresh.length} из ${items.length} элем. (актор ${actorId})`);
      } catch (err) {
        const reason = err instanceof ApifyError ? err.message : `сбой сбора: ${err.message}`;
        perPlatform.push({ platform, count: 0, error: reason, actorId });
        notes.push(`${platform}: ${reason}`);
      }
    }

    return { posts, notes, perPlatform };
  },
};

export const loginProvider = {
  name: 'login',

  available() {
    return {
      ok: false,
      error:
        'вариант C (логин основным аккаунтом) — резервный путь и он НЕ реализован. Основной путь ' +
        'сейчас Apify (TRENDS_PROVIDER=apify). Чтобы включить резерв, сначала нужны: резидентный ' +
        'прокси, постоянная cookie-сессия без релогина, строго 1 прогон/день и человекоподобный ' +
        'темп — без них это прямой бан-риск для аккаунта клиента (см. specs/trends-apify.md).',
    };
  },

  async collect() {
    throw new Error(loginProvider.available().error);
  },
};

const PROVIDERS = { apify: apifyProvider, login: loginProvider };

/** Провайдер по имени из .env (TRENDS_PROVIDER). Неизвестное имя — явная ошибка, не тихий дефолт. */
export function getProvider(name = 'apify') {
  const provider = PROVIDERS[String(name || '').trim().toLowerCase()];
  if (!provider) throw new Error(`неизвестный TRENDS_PROVIDER=«${name}» (бывают: ${Object.keys(PROVIDERS).join(', ')})`);
  return provider;
}

/** Откуда пост: сверяем подсказки актора с нашими целями. */
function resolveSource(raw, targets) {
  for (const field of SOURCE_HINT_FIELDS) {
    const v = raw?.[field];
    if (!v) continue;
    const byUrl = sourceQueryFor(targets, String(v));
    if (byUrl) return byUrl;
    const hit = targets.find((t) => String(v).toLowerCase().includes(t.value.toLowerCase()));
    if (hit) return `${hit.type === 'hashtag' ? '#' : '@'}${hit.value}`;
  }
  return null;
}

/** Если актор не сказал источник — выводим его по автору, когда автор есть среди наших аккаунтов. */
function fillSourceByAuthor(posts, targets) {
  const accounts = new Map(
    targets.filter((t) => t.type === 'account').map((t) => [t.value.toLowerCase(), t.value]),
  );
  for (const p of posts) {
    if (p.sourceQuery || !p.author) continue;
    const hit = accounts.get(p.author.toLowerCase());
    if (hit) p.sourceQuery = `@${hit}`;
  }
}
