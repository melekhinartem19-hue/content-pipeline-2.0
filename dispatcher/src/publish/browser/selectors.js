// Селекторы веб-интерфейса Instagram и Threads — ВСЕ в одном файле.
//
// ПОЧЕМУ ОТДЕЛЬНЫМ ФАЙЛОМ. Вёрстку Instagram меняет без предупреждения и без версионирования:
// классы там сгенерированные (`x1i10hfl x972fbf…`), завязываться на них нельзя вообще. Когда
// очередной релиз сломает вход или публикацию, чинить придётся здесь и только здесь — не выискивая
// строку с селектором посреди логики. Поэтому в session.js и instagram.js не должно быть НИ ОДНОГО
// литерала селектора.
//
// ПРИНЦИПЫ ВЫБОРА (в порядке надёжности):
//   1) cookie и URL          — вёрстке не подвластны, переживают любой редизайн;
//   2) name= у полей формы   — меняются реже всего, формы логина живут годами;
//   3) роль + видимый текст  — держится на локали, поэтому контекст форсирует en-US (см. session.js);
//   4) генерируемые классы   — НЕ используем никогда.
//
// Каждая запись — МАССИВ вариантов: пробуем по очереди, первый найденный выигрывает. Instagram
// раскатывает изменения процентом аудитории, поэтому у клиента может быть версия, которой у нас
// на отладке не было, — запасной вариант дешевле, чем сломанная публикация.

export const IG_ORIGIN = 'https://www.instagram.com';

// Threads переехал с threads.net на threads.com; старый адрес пока редиректит, но опираемся на новый.
export const THREADS_ORIGIN = 'https://www.threads.com';

/**
 * Признак «мы залогинены» — это КУКА, а не элемент страницы.
 * sessionid ставится обеими площадками после успешного входа и живёт в профиле браузера.
 * Проверка по куке не зависит от языка, редизайна и от того, докрутилась ли лента.
 */
export const SESSION_COOKIE = 'sessionid';

export const IG = {
  loginUrl: `${IG_ORIGIN}/accounts/login/`,

  // Поля формы входа. name= у них не менялся годами — самый устойчивый якорь после куки.
  username: ['input[name="username"]'],
  password: ['input[name="password"]'],
  submit: ['button[type="submit"]'],

  // Баннер согласия на cookie (ЕС и часть регионов). Пока он висит, форма перекрыта оверлеем
  // и клик по «Войти» уходит в пустоту — поэтому его закрываем ДО ввода логина.
  cookieBanner: [
    'button:has-text("Allow all cookies")',
    'button:has-text("Accept all")',
    'button:has-text("Only allow essential cookies")',
  ],

  // Текст ошибки входа (неверный пароль и т.п.) — чтобы не ждать таймаут молча.
  loginError: ['#slfErrorAlert', '[role="alert"]'],

  // Поле кода при чекпойнте/2FA. Разные ветки проверки называют его по-разному.
  code: [
    'input[name="verificationCode"]',
    'input[name="security_code"]',
    'input[name="email"][maxlength="8"]',
    'input[autocomplete="one-time-code"]',
  ],
  codeSubmit: ['button:has-text("Confirm")', 'button:has-text("Continue")', 'button[type="button"]:has-text("Submit")'],

  // Шаг «куда прислать код» — иногда сначала просят выбрать способ и нажать Send.
  codeSend: ['button:has-text("Send Security Code")', 'button:has-text("Send Code")'],

  // Диалоги после входа: «Сохранить данные для входа?» и «Включить уведомления?».
  // Их надо закрыть, иначе они перекрывают интерфейс и следующий шаг кликает мимо.
  saveLoginInfo: ['button:has-text("Save info")', 'button:has-text("Save Info")'],
  dismissDialog: ['button:has-text("Not now")', 'button:has-text("Not Now")'],

  // ── Публикация поста ────────────────────────────────────────────────────
  // Кнопка «создать». aria-label устойчивее текста: подпись в боковом меню то появляется,
  // то прячется под иконку в зависимости от ширины окна.
  create: [
    'svg[aria-label="New post"]',
    'a[href="/create/select/"]',
    'div[role="button"]:has-text("Create")',
    'span:has-text("Create")',
  ],

  // Иногда после «Create» открывается подменю с выбором «Post / Reel / Story».
  createPost: ['div[role="button"]:has-text("Post")', 'span:has-text("Post")'],

  // Файл отдаём НАПРЯМУЮ в input, а не через кнопку «Select from computer»: она открывает
  // системный диалог выбора файла, которым из headless-браузера управлять нечем.
  fileInput: ['input[type="file"][accept*="image"]', 'input[type="file"]'],

  // Шаги мастера: обрезка → фильтры → подпись. Кнопка на всех одна и та же по смыслу.
  next: ['div[role="button"]:has-text("Next")', 'button:has-text("Next")'],
  share: ['div[role="button"]:has-text("Share")', 'button:has-text("Share")'],

  // Поле подписи. Это contenteditable, а не textarea, — fill() по нему работает, type() надёжнее.
  caption: ['textarea[aria-label*="caption"]', 'div[contenteditable="true"][role="textbox"]', 'textarea'],

  // Подтверждение, что пост ушёл. Ловим по тексту, потому что своего URL у результата нет.
  shared: [
    'span:has-text("Your post has been shared")',
    'span:has-text("Your reel has been shared")',
    'img[alt*="Animated checkmark"]',
  ],

  // Диалог «выйти из редактора?» — вылезает, если публикация сорвалась и мы закрываем окно.
  discard: ['button:has-text("Discard")', 'div[role="button"]:has-text("Discard")'],

  // Первый пост в сетке профиля: по нему после публикации достаём ссылку на пост.
  firstProfilePost: ['main article a[href*="/p/"]', 'main a[href*="/p/"]', 'main a[href*="/reel/"]'],
};

/**
 * URL-признаки того, что вход упёрся в проверку. Сравниваем с адресом страницы, а не с текстом:
 * формулировки Instagram переводит и переписывает, маршруты — почти никогда.
 */
export const IG_CHALLENGE_URLS = ['/challenge', '/two_factor', '/accounts/suspended', '/accounts/disabled'];

export const THREADS = {
  loginUrl: `${THREADS_ORIGIN}/login`,

  // Threads не заводит отдельный пароль: вход идёт аккаунтом Instagram. Если в профиле уже есть
  // живая сессия Instagram, здесь достаточно подтвердить её кнопкой — пароль не спрашивают.
  continueWithInstagram: [
    'div[role="button"]:has-text("Continue with Instagram")',
    'a:has-text("Continue with Instagram")',
    'button:has-text("Continue with Instagram")',
    'div[role="button"]:has-text("Continue as")',
  ],

  // Признак рабочего интерфейса: есть поле «что нового». Куки хватает, это запасная проверка.
  composer: ['div[role="button"]:has-text("What\'s new")', 'textarea[placeholder*="new"]'],

  // ── Публикация поста ────────────────────────────────────────────────────
  // Threads проще Instagram: никакого мастера с шагами — открыть окно, вписать текст, отправить.
  openComposer: [
    'div[role="button"]:has-text("What\'s new")',
    'div[role="button"][aria-label*="Create"]',
    'svg[aria-label="Create"]',
  ],

  // Поле ввода внутри открытого окна. Тоже contenteditable, а не textarea.
  input: ['div[contenteditable="true"][role="textbox"]', 'textarea[placeholder*="new"]'],

  post: ['div[role="button"]:has-text("Post")', 'button:has-text("Post")'],

  // Ссылка на свежий пост в своём профиле — отсюда берём ref после публикации.
  firstProfilePost: ['a[href*="/post/"]'],
};
