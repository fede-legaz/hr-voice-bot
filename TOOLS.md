# HRBOT Onboarding API

## Base

- Base URL: `https://lobster-app-68eq9.ondigitalocean.app`
- Auth header: `Authorization: Bearer <OPENCLAW_AGENT_TOKEN>`
- Content type: `application/json`

These endpoints are intended for external agents like OpenClaw.

## What This Adds

HRBOT now supports:

1. Creating an onboarding from an external system
2. Listing onboardings with real completion progress
3. Reading one onboarding with docs and progress
4. Sending the onboarding link by SMS
5. Configuring a completion webhook
6. Automatically notifying an external system when an onboarding becomes complete
7. Forcing a completion webhook resend

## Completion Logic

An onboarding is considered `completed` when all required docs in `profile.doc_types` are done.

Rules:

- Upload/PDF/Form docs count as complete when a document record exists
- Policy docs count as complete when `policy_ack = true` or the signed policy doc exists
- HRBOT sends the completion webhook only once by default

## Endpoints

### 1. Read webhook config

`GET /openclaw/onboarding/config`

Response:

```json
{
  "ok": true,
  "config": {
    "completion_webhook_url": "https://your-system.com/hrbot/onboarding",
    "completion_webhook_event": "onboarding.completed",
    "has_completion_webhook_bearer_token": true
  }
}
```

### 2. Update webhook config

`POST /openclaw/onboarding/config`

Body:

```json
{
  "completion_webhook_url": "https://your-system.com/hrbot/onboarding",
  "completion_webhook_bearer_token": "secret_token_here",
  "completion_webhook_event": "onboarding.completed"
}
```

Notes:

- `completion_webhook_url` is where HRBOT will send the automatic notification
- `completion_webhook_bearer_token` is optional
- if you send a bearer token, HRBOT will include `Authorization: Bearer <token>` in the webhook call

### 3. Create onboarding

`POST /openclaw/onboarding`

You can create onboarding in 3 modes:

- from `cv_id`
- from `call_sid`
- manual

#### Manual example

```json
{
  "manual": true,
  "name": "Jane Doe",
  "email": "jane@example.com",
  "phone": "+13055550111",
  "brand": "Yes Cafe Miami Beach",
  "role": "Cashier",
  "onboarding_type": "w2",
  "external_ref": "ocw-employee-123"
}
```

#### From CV example

```json
{
  "cv_id": "cv_123",
  "external_ref": "ocw-employee-123"
}
```

#### From call example

```json
{
  "call_sid": "CA123456789",
  "external_ref": "ocw-employee-123"
}
```

Response:

```json
{
  "ok": true,
  "onboarding": {
    "id": "onb_123",
    "name": "Jane Doe",
    "brand": "Yes Cafe Miami Beach",
    "role": "Cashier",
    "external_ref": "ocw-employee-123",
    "status": "pending",
    "public_url": "https://lobster-app-68eq9.ondigitalocean.app/onboard/...",
    "packet_url": "https://lobster-app-68eq9.ondigitalocean.app/admin/onboarding/onb_123/packet?download=1",
    "progress": {
      "required_count": 5,
      "completed_count": 0,
      "pending_count": 5,
      "missing_doc_keys": ["id", "i9", "ss", "w4", "policy_renuncia"],
      "is_complete": false
    }
  },
  "docs": [],
  "progress": {
    "required_count": 5,
    "completed_count": 0,
    "pending_count": 5,
    "missing_doc_keys": ["id", "i9", "ss", "w4", "policy_renuncia"],
    "is_complete": false
  }
}
```

### 4. List onboardings

`GET /openclaw/onboarding`

Query params:

- `brand`
- `q`
- `status` = `pending` | `completed` | `hired`
- `limit`

Example:

```bash
curl -H "Authorization: Bearer $OPENCLAW_AGENT_TOKEN" \
  "$HRBOT_BASE_URL/openclaw/onboarding?status=pending&limit=20"
```

Response:

```json
{
  "ok": true,
  "items": [
    {
      "id": "onb_123",
      "name": "Jane Doe",
      "brand": "Yes Cafe Miami Beach",
      "role": "Cashier",
      "external_ref": "ocw-employee-123",
      "status": "pending",
      "public_url": "https://lobster-app-68eq9.ondigitalocean.app/onboard/...",
      "packet_url": "https://lobster-app-68eq9.ondigitalocean.app/admin/onboarding/onb_123/packet?download=1",
      "progress": {
        "required_count": 5,
        "completed_count": 2,
        "pending_count": 3,
        "missing_doc_keys": ["i9", "w4", "policy_renuncia"],
        "is_complete": false
      },
      "decision": ""
    }
  ]
}
```

### 5. Read one onboarding

`GET /openclaw/onboarding/:id`

Example:

```bash
curl -H "Authorization: Bearer $OPENCLAW_AGENT_TOKEN" \
  "$HRBOT_BASE_URL/openclaw/onboarding/onb_123"
```

Response:

```json
{
  "ok": true,
  "onboarding": {
    "id": "onb_123",
    "name": "Jane Doe",
    "brand": "Yes Cafe Miami Beach",
    "role": "Cashier",
    "status": "completed",
    "public_url": "https://lobster-app-68eq9.ondigitalocean.app/onboard/...",
    "packet_url": "https://lobster-app-68eq9.ondigitalocean.app/admin/onboarding/onb_123/packet?download=1",
    "progress": {
      "required_count": 5,
      "completed_count": 5,
      "pending_count": 0,
      "missing_doc_keys": [],
      "is_complete": true
    }
  },
  "docs": [
    {
      "id": "doc_1",
      "doc_type": "id",
      "doc_url": "https://...",
      "uploaded_by": "candidate",
      "created_at": "2026-03-20T12:00:00.000Z"
    }
  ],
  "progress": {
    "required_count": 5,
    "completed_count": 5,
    "pending_count": 0,
    "missing_doc_keys": [],
    "is_complete": true
  },
  "webhook": null
}
```

### 6. Send onboarding SMS

`POST /openclaw/onboarding/:id/send-sms`

Body:

```json
{
  "phone": "+13055550111",
  "save_phone": true
}
```

If `phone` is omitted, HRBOT uses the phone already saved on the onboarding.

Response:

```json
{
  "ok": true,
  "onboarding": {
    "id": "onb_123",
    "last_sms_phone": "+13055550111",
    "last_sms_sent_at": "2026-03-20T12:10:00.000Z"
  }
}
```

### 7. Force resend completion webhook

`POST /openclaw/onboarding/:id/resend-completion`

Use this when:

- the onboarding is already complete
- the external receiver missed the first notification
- you want HRBOT to send the webhook again

Response:

```json
{
  "ok": true,
  "onboarding": {
    "id": "onb_123",
    "status": "completed"
  },
  "progress": {
    "is_complete": true
  },
  "webhook": {
    "ok": true,
    "sent_at": "2026-03-20T12:15:00.000Z",
    "status": 200
  }
}
```

If the onboarding is not complete yet, HRBOT returns:

```json
{
  "error": "onboarding_not_complete"
}
```

## Automatic Completion Webhook

When an onboarding becomes complete, HRBOT sends a `POST` to the configured `completion_webhook_url`.

### Webhook headers

Always:

```text
Content-Type: application/json
```

If configured:

```text
Authorization: Bearer <completion_webhook_bearer_token>
```

### Webhook payload

```json
{
  "ok": true,
  "event": "onboarding.completed",
  "sent_at": "2026-03-20T12:20:00.000Z",
  "force": false,
  "reason": "candidate_pdf",
  "onboarding": {
    "id": "onb_123",
    "external_ref": "ocw-employee-123",
    "cv_id": "cv_123",
    "call_sid": "",
    "name": "Jane Doe",
    "email": "jane@example.com",
    "phone": "+13055550111",
    "brand": "Yes Cafe Miami Beach",
    "role": "Cashier",
    "onboarding_type": "w2",
    "status": "completed",
    "public_url": "https://lobster-app-68eq9.ondigitalocean.app/onboard/...",
    "packet_url": "https://lobster-app-68eq9.ondigitalocean.app/admin/onboarding/onb_123/packet?download=1",
    "completed_at": "2026-03-20T12:20:00.000Z",
    "policy_ack": true,
    "progress": {
      "required_count": 5,
      "completed_count": 5,
      "pending_count": 0,
      "missing_doc_keys": [],
      "is_complete": true
    }
  },
  "docs": [
    {
      "id": "doc_1",
      "doc_type": "id",
      "doc_url": "https://...",
      "uploaded_by": "candidate",
      "created_at": "2026-03-20T12:00:00.000Z"
    }
  ]
}
```

## Existing Admin Endpoints Still Work

With the same OpenClaw bearer token, you can also call the existing admin endpoints:

- `POST /admin/onboarding/create`
- `GET /admin/onboarding/list`
- `GET /admin/onboarding/:id`
- `POST /admin/onboarding/:id/profile`
- `POST /admin/onboarding/:id/send-sms`
- `GET /admin/onboarding/:id/packet`

The new `/openclaw/onboarding/*` endpoints are just cleaner for external agents because they return:

- real completion progress
- cleaner payloads
- webhook-oriented behavior

## Suggested OpenClaw Tool Wrappers

- `hr_get_capabilities` -> `GET /openclaw/capabilities`
- `hr_list_candidates` -> `GET /admin/cv`
- `hr_get_candidate` -> `GET /openclaw/cv/:id`
- `hr_list_calls` -> `GET /admin/calls`
- `hr_get_call` -> `GET /openclaw/calls/:callId`
- `hr_send_onboarding_sms` -> `POST /openclaw/onboarding/:id/send-sms`
- `hr_send_candidate_sms` -> `POST /admin/messages/send`

## Candidate Messaging

OpenClaw can send candidate SMS through the existing admin route:

- `POST /admin/messages/send`

Supported request body:

```json
{
  "cv_id": "907b6c83f828795c8a498142eee9e21a",
  "body": "Hola Federico, te escribo de New Campo Argentino para coordinar el siguiente paso."
}
```

Or by direct phone:

```json
{
  "phone": "+17863064543",
  "body": "Hola Federico, te escribo de New Campo Argentino para coordinar el siguiente paso."
}
```

Response includes:

- `ok`
- `phone`
- `contact`
- `guard`
- `message`

Operational notes:

- If the candidate opted out, HRBOT returns `sms_opted_out`
- If there is an active cooldown, HRBOT returns `sms_cooldown`
- If there are too many unanswered outbound SMS, HRBOT returns `sms_pending_limit`

## Recommended External Flow

1. Configure webhook target once:

```bash
curl -X POST \
  -H "Authorization: Bearer $OPENCLAW_AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  "$HRBOT_BASE_URL/openclaw/onboarding/config" \
  -d '{
    "completion_webhook_url": "https://your-system.com/hrbot/onboarding",
    "completion_webhook_bearer_token": "secret_token_here",
    "completion_webhook_event": "onboarding.completed"
  }'
```

2. Create onboarding:

```bash
curl -X POST \
  -H "Authorization: Bearer $OPENCLAW_AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  "$HRBOT_BASE_URL/openclaw/onboarding" \
  -d '{
    "manual": true,
    "name": "Jane Doe",
    "email": "jane@example.com",
    "phone": "+13055550111",
    "brand": "Yes Cafe Miami Beach",
    "role": "Cashier",
    "onboarding_type": "w2",
    "external_ref": "ocw-employee-123"
  }'
```

3. Send onboarding link:

```bash
curl -X POST \
  -H "Authorization: Bearer $OPENCLAW_AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  "$HRBOT_BASE_URL/openclaw/onboarding/onb_123/send-sms" \
  -d '{
    "phone": "+13055550111",
    "save_phone": true
  }'
```

4. Wait for automatic webhook when docs are complete

5. If needed, force resend:

```bash
curl -X POST \
  -H "Authorization: Bearer $OPENCLAW_AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  "$HRBOT_BASE_URL/openclaw/onboarding/onb_123/resend-completion" \
  -d '{}'
```

## Errors You May See

- `missing_target`
  You did not send `cv_id`, `call_sid`, or `manual: true`

- `missing_name`
  Manual creation is missing candidate name

- `missing_brand`
  Manual creation is missing location

- `missing_role`
  Manual creation is missing role

- `brand_not_allowed`
  The authenticated user is restricted from that brand

- `missing_phone`
  SMS endpoint has no phone to use

- `missing_pin`
  The phone did not produce a valid 4-digit pin

- `onboarding_not_complete`
  You tried to resend completion for an onboarding that is not complete yet

## File Reference

Implementation lives in:

- `/Users/fedelegaz/projects/HRBOT/server.js`
