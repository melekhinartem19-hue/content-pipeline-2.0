# Автозапуск диспетчера (systemd)

Диспетчер — один долгоживущий процесс со всеми шестью ботами. Он должен подниматься сам после
перезагрузки сервера и после падения: пока он лежит, не работает ничего, кроме уже разосланных
ссылок на PDF (воронка ManyChat читает поля на своей стороне и наш аптайм ей не нужен).

## Установка

```bash
sudo cp /opt/content-pipeline/deploy/systemd/content-pipeline.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now content-pipeline
systemctl status content-pipeline        # active (running)
```

Юнит написан под пути из [../vps-setup.md](../vps-setup.md): код в `/opt/content-pipeline`,
пользователь `pipeline`, статика в `/var/www/content-pipeline`. Если пути другие — править
`WorkingDirectory`, `Environment=HOME`, `ReadWritePaths` **вместе**: они связаны.

## Повседневные команды

```bash
journalctl -u content-pipeline -f          # живой лог (сюда пишутся вызовы claude, Apify, Meta)
journalctl -u content-pipeline -n 200      # последние 200 строк
sudo systemctl restart content-pipeline    # после правки .env — обязательно
sudo systemctl stop content-pipeline       # на время обслуживания
```

**`.env` перечитывается только при рестарте.** Поменяли токен или `PUBLIC_BASE_URL` — сделайте
`restart`, иначе процесс продолжит работать со старыми значениями.

## Типовые сбои

| Симптом | Причина | Лечение |
|---|---|---|
| `status=203/EXEC` | не найден `node` по `/usr/bin/node` | `which node` и подставить реальный путь в `ExecStart` |
| Боты живы, но агенты не отвечают | нет `HOME` → `claude -p` не видит логин | проверить `Environment=HOME` в юните; `sudo -u pipeline bash -lc 'claude -p "ок"'` |
| `Error: Cannot find module` | зависимости ставились под root | переустановить от `pipeline` (см. vps-setup, шаг 4) |
| Картинки/PDF не собираются | браузер или шрифты не видны из-под сервиса | `sudo -u pipeline bash -lc 'cd /opt/content-pipeline/dispatcher && npm run smoke'` |
| Процесс перезапускается по кругу | нет обязательных переменных в `.env` | `journalctl -u content-pipeline -n 50` — диспетчер честно пишет, чего не хватает |

## Память

На VPS с 2 ГБ рендер каруселей и PDF поднимает headless-браузер — это самый прожорливый момент.
Если в логе появляются падения браузера, добавьте swap:

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```
