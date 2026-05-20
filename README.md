# WARP API — Vercel Serverless

Получает сессию Cloudflare WARP и возвращает минимальный набор данных клиенту.
Клиент сам строит `.conf` файл локально и подставляет свой relay/endpoint.

---

## Деплой на Vercel

```bash
npm i -g vercel
vercel --prod
```

### Env переменная (обязательно)

В Vercel → Project → Settings → Environment Variables:

| Key          | Value           |
|--------------|-----------------|
| `API_SECRET` | ваш секрет      |

Если `API_SECRET` не задан — API открыт для всех.

---

## Endpoints

### `GET /api/warp`  или  `POST /api/warp`

Создать новую WARP сессию.

**Заголовок:**
```
X-API-Secret: <ваш секрет>
```

**Успешный ответ `200`:**
```json
{
  "ok": true,
  "private_key": "base64...",
  "peer_public_key": "base64...",
  "client_ipv4": "172.16.0.2/32",
  "client_ipv6": "2606:4700:110:8f4e::1/128",
  "account_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "token": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
}
```

Сохраните `account_id` и `token` — они нужны для удаления аккаунта.

---

### `DELETE /api/warp`

Удалить аккаунт WARP из Cloudflare.

**Заголовок:**
```
X-API-Secret: <ваш секрет>
Content-Type: application/json
```

**Тело:**
```json
{
  "account_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "token": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
}
```

**Успешный ответ `200`:**
```json
{
  "ok": true,
  "message": "account_deleted",
  "account_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
}
```

---

## Ошибки

| HTTP | error                          | Причина                              |
|------|--------------------------------|--------------------------------------|
| 401  | `unauthorized`                 | Неверный или отсутствует X-API-Secret |
| 400  | `missing_fields`               | DELETE без account_id / token        |
| 502  | `invalid_registration_response`| CF вернул неожиданный ответ          |
| 502  | `incomplete_config`            | CF не вернул peer_key или адрес      |
| 503  | `cloudflare_unreachable`       | CF недоступен после 3 попыток        |
| 4xx  | `registration_failed`          | CF отклонил регистрацию              |
| 4xx  | `activation_failed`            | CF отклонил активацию WARP           |
| 500  | `keygen_failed`                | Ошибка генерации ключей              |
| 405  | `method_not_allowed`           | Метод не поддерживается              |

---

## Пример: сборка конфига на клиенте (bash)

```bash
RELAY_IP="83.143.112.121"
RELAY_PORT="2408"

resp=$(curl -s -H "X-API-Secret: ВАШ_СЕКРЕТ" https://your-app.vercel.app/api/warp)

priv=$(echo "$resp"    | jq -r '.private_key')
peer=$(echo "$resp"    | jq -r '.peer_public_key')
ipv4=$(echo "$resp"    | jq -r '.client_ipv4')
ipv6=$(echo "$resp"    | jq -r '.client_ipv6')

cat > WARP.conf <<EOF
[Interface]
PrivateKey = $priv
S1 = 0
S2 = 0
Jc = 120
Jmin = 23
Jmax = 911
H1 = 1
H2 = 2
H3 = 3
H4 = 4
MTU = 1280
Address = $ipv4, $ipv6
DNS = 1.1.1.1, 2606:4700:4700::1111

[Peer]
PublicKey = $peer
AllowedIPs = 0.0.0.0/0, ::/0
Endpoint = ${RELAY_IP}:${RELAY_PORT}
EOF

echo "Готово: WARP.conf"
```
