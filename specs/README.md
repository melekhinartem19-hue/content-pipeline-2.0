# `specs/` — как устроен каждый модуль

По файлу на модуль. Спека отвечает на три вопроса: **что делает**, **почему сделано именно так**
и **где границы** (что обещать клиенту нельзя). Код при этом остаётся источником правды о деталях —
спека объясняет решения, а не пересказывает функции.

> Устройство системы целиком и правила, нарушать которые нельзя, — в [../CLAUDE.md](../CLAUDE.md).
> Карта работ и тикеты — в [backlog/](backlog/).

## Порядок чтения (он же порядок сборки)

| Фаза | Спека | О чём |
|---|---|---|
| 0 | [dispatcher.md](dispatcher.md) | спайн: Telegram → `claude -p` → Telegram, «тупая труба» |
| 0 | [db.md](db.md) | слой доступа к SQLite и точки переезда на Postgres |
| 0 | [bots-rollout-plan.md](bots-rollout-plan.md) | как поднимались 6 ботов и форум-группа |
| 0 | [agent-contract.md](agent-contract.md) | агент = файл в `agents/` + brand-brain + META-конверт |
| 1 | [producer-orchestration.md](producer-orchestration.md) | Продюсер раздаёт задачи по топикам, `/статус` |
| 1 | [approval-queue.md](approval-queue.md) | очередь, карточки с кнопками, правки, варианты |
| 1 | [tg-publish.md](tg-publish.md) | публикация в TG-канал и слоты календаря |
| 2 | [trends-apify.md](trends-apify.md) | сбор трендов через Apify и разбор тем Разведчиком |
| 2 | [render-visuals.md](render-visuals.md) | спецификация Дизайнера → PNG каруселей и обложек |
| 2 | [ig-threads-publish.md](ig-threads-publish.md) | Graph API в dev-mode: Instagram и Threads |
| 2 | [ig-browser-publish.md](ig-browser-publish.md) | вариант C: вход в аккаунт и публикация живым браузером |
| 3 | [presenter-pdf.md](presenter-pdf.md) | три PDF-лид-магнита инста-воронки |
| 3 | [manychat-funnel.md](manychat-funnel.md) | воронка в ManyChat: три ключа → три ссылки |
| 4 | [video-pipeline.md](video-pipeline.md) | монтаж на ноуте, приём ролика на VPS, автомонтаж |
| 5 | [analytics.md](analytics.md) | Аналитик: факты конвейера + метрики площадок |
| — | [brand-inbox.md](brand-inbox.md) | «Мозг бренда»: идеи и файлы клиента → brand-brain |

## Что читать, если нужно…

- **понять систему за 10 минут** → [../CLAUDE.md](../CLAUDE.md), затем [dispatcher.md](dispatcher.md);
- **поставить продукт на сервер** → [../deploy/](../deploy/);
- **разобраться, почему что-то нельзя** → раздел «Границы» в нужной спеке и «Правила» в CLAUDE.md;
- **добавить агента** → [agent-contract.md](agent-contract.md) и [../agents/README.md](../agents/README.md);
- **менять данные, а не код** → `trends/sources.json`, `manychat/funnel.json`, `brand-brain/`.
