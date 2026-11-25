# Архитектура CrustCaper Mobile

## Поток гостевого заказа

Экран меню передаёт позиции и модификаторы в локальную корзину. Оформление проверяет ввод, получает предложение и показывает итог с окном выдачи. Состояние текущего заказа переживает повторное открытие приложения. Экран заказа читает состояние через адаптер; правила цены, слота, доступа и платёжного исхода находятся на серверной стороне контракта.

| Часть | Код |
| --- | --- |
| Маршруты и экран оформления | [app](../../app), [checkout.tsx](../../app/checkout.tsx) |
| Корзина, каталог и язык | [shop.tsx](../../src/state/shop.tsx) |
| Переходы оформления и журнал | [controller.ts](../../src/checkout/controller.ts), [private-storage.ts](../../src/state/private-storage.ts) |
| Прикладной интерфейс и демо-данные | [types.ts](../../src/domain/types.ts), [demo-api.ts](../../src/domain/demo-api.ts) |
| Подключённый HTTP-клиент | [http-api.ts](../../src/live/http-api.ts), [wire.ts](../../src/live/wire.ts) |
| Сервер, платежи и панель точки | [server](../../server/README.md) |

Общий API обслуживает меню, гостевую сессию, котировку, заказ, оплату и восстановление. PostgreSQL проверяет доступ по сессии и резервирует доступные слоты под блокировкой. Клиент проверяет формат ответа и отображает сумму, валюту, окно и состояния, полученные от сервера. [Контракт API](../../contracts/README.md)

Денежные суммы передаются целыми числами в RWF. UTC хранит момент события. Отображение окна выдачи использует `Africa/Kigali`. Если цена, доступность или слот изменились, клиент показывает обновлённое предложение и получает согласие перед записью.

## ADR 001 Профили приложения и общий API

Профиль demo поддерживает автономный сценарий. Профиль local подключается к Spring Boot и PostgreSQL и разрешает синтетическое завершение платежа. Профили stage и production обращаются к заданному HTTPS API. Metro разделяет кэш по публичной конфигурации сборки.

Черновик корзины хранится в AsyncStorage на телефоне и в sessionStorage вкладки в браузере. Журнал оформления сохраняет стадию, ключ повторного обращения и идентификаторы заказов. В нативной версии журнал и гостевые токены защищены SecureStore и изолированы по профилю, адресу API и точке. Клиент обновляет access с тем же refresh токеном и сохраняет права исходного гостя. Телефон и email передаются API при оформлении и отсутствуют в журнале клиента.

До открытия PSP приложение сохраняет orderId и ключ попытки. Системный браузер открывает HTTPS-ссылку с разрешённого хоста. После возврата и холодного старта статус запрашивается по сохранённому заказу. Доступ и окончательный исход оплаты проверяет API. При неоднозначном ответе клиент восстанавливает существующую операцию. После подтверждения оплаты заказ появляется в очереди ресторана. Роль выдачи подтверждает код, а сервер записывает завершение в журнал действий.

## Риски и доказательства подключения

| Риск | Контроль и проверка | Ответственный |
| --- | --- | --- |
| Чужой заказ по ссылке | Проверка владельца на API; сценарии с двумя сессиями, отзывом и неподтверждённым контактом. | API |
| Повтор записи при таймауте или двух нажатиях | Ключ намерения и сравнение запроса на сервере, сохранение ID на клиенте. Проверки конкуренции, обрыва после принятия и перезапуска. | API, Mobile |
| Утечка через сборку, логи или push | Разделение сред, проверка SDK и разрешений, защищённое хранилище токенов, общие тексты уведомлений. Проверка конфигурации и фактической сборки. | Mobile, владелец данных |
| Подмена статуса оплаты | Сверка на сервере, системный браузер с разрешённым HTTPS-хостом, ассоциированные ссылки согласованного домена. Проверка задержки, ошибочного возврата и истёкшей брони. | API, Mobile |

## Зависимости и изображения

Для SDK 55 закреплены исправленные версии Zod в Expo CLI и decode-uri-component в цепочке Expo Router. Metro перенаправляет CommonJS-импорт декодера из query-string 7 на совместимый экспорт. При обновлении Router и CLI пересмотреть закрепления и прогнать экспорт всех платформ и навигацию с параметрами.

Знак CrustCaper взят из фирменного макета в плане сайта, фото Double Smash — из концепта мобильного приложения. Остальные изображения меню созданы с помощью встроенного ImageGen по одной серии фотореалистичных кадров на бумаге и бордовом фоне. Каталог демонстрационный. Для пилота нужны фото реальных блюд и утверждённые сведения о составе и аллергенах.

Запрос к ImageGen

> Generate one photographic contact sheet, landscape 3:2 overall, exact 3 columns and 2 rows of six equal rectangles edge-to-edge, straight grid, absolutely no frames, gutters, dividers, lettering or graphic labels. Each panel independent and intended for center crop. Food product photography for CrustCaper in Kigali, dark warm aubergine #2B1827 backdrop in every rectangle, food on crinkled kraft parchment, warm directional studio light, true restaurant portion, realistic. Top row left classic single smash beef cheeseburger, middle hotter double smash cheeseburger with red pepper relish, right golden crispy chicken burger with a lettuce leaf. Bottom row left veggie bean patty burger with lettuce, middle paper cup of crunchy golden fries, right clear glass bottle and iced glass of sparkling soda with no labels. Fully contained isolated subjects, center each at exact sixth-cell centers, leave side breathing room with dark aubergine background, 3/4 food photography hero angle, no hands, no people, no props besides paper, no text. Cohesive editorial photography.
