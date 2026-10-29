# Публичная статика: зачем она и как проверить

Два места в системе физически не работают без публичных ссылок:

1. **Instagram не принимает файл.** Graph API берёт `image_url`/`video_url` и **качает медиа
   своими серверами**. Локальный файл он не примет никогда — это устройство API, а не наша
   недоделка. Поэтому кадры карусели копируются в `PUBLIC_DIR` и уходят в Meta https-адресом.
2. **Файл-PDF в инста-директ отправить нельзя.** Воронка отдаёт **ссылку** на лид-магнит. Нет
   статики — нечего отдавать (остаётся только увод в Telegram).

Отсюда правило: `PUBLIC_DIR` и `PUBLIC_BASE_URL` в `.env` должны указывать на **одно и то же
место** — папку, которую раздаёт Nginx, и её адрес снаружи.

```
dispatcher/.env                     Nginx
PUBLIC_DIR=/var/www/content-pipeline   ← root
PUBLIC_BASE_URL=https://media.ПРИМЕР.ru  ← server_name + HTTPS
```

## Установка

```bash
sudo cp /opt/content-pipeline/deploy/nginx/content-pipeline.conf /etc/nginx/sites-available/content-pipeline
sudo nano /etc/nginx/sites-available/content-pipeline        # заменить media.ПРИМЕР.ru на домен клиента
sudo ln -s /etc/nginx/sites-available/content-pipeline /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d media.ПРИМЕР.ru
```

**HTTPS обязателен, и сертификат — настоящий.** По `http://` и с самоподписанным сертификатом
Meta медиа не заберёт, а публикация упадёт с невнятной ошибкой скачивания.

## Проверка

```bash
# положить пробный файл от имени сервиса и открыть его снаружи
sudo -u pipeline bash -lc 'echo ok > /var/www/content-pipeline/check.txt'
curl -I https://media.ПРИМЕР.ru/check.txt      # 200 OK
sudo -u pipeline rm /var/www/content-pipeline/check.txt
```

Боевая проверка — после первой сборки PDF: `/пдф` в топике Презентатора, затем `/воронка` покажет
готовые ссылки. Каждая должна открываться в браузере **с телефона, не из локальной сети**.

## Права на файлы

Файлы пишет пользователь `pipeline`, читает `www-data`. Если Nginx отвечает 403 — проверить, что
каталог доступен на чтение всем:

```bash
sudo chown -R pipeline:pipeline /var/www/content-pipeline
sudo chmod -R a+rX /var/www/content-pipeline
```

## Гоча, которая ломает воронку тихо

**`PUBLIC_BASE_URL` менять после запуска воронки нельзя.** Адрес попадает в разосланные людям
ссылки и в bot-поля ManyChat. Если домен всё же сменился: диспетчер помнит, что именно записал в
ManyChat, покажет расхождение в `/воронка` и починит его командой `/воронка синх` — но ссылки,
которые люди уже получили в директе, станут нерабочими. То же самое касается `PDF_PUBLIC_SUBDIR`
и ключей тем в `manychat/funnel.json`.
