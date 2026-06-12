---
name: api-tutorial
description: How to call our public REST API.
owner: dx-team
tags: [api, tutorial]
---

# Calling the API

Our API lives at https://api.example.com. You can fetch your profile with a
GET request. Many users post comments and upload avatars through the same host.

Example with curl:

```sh
curl -s https://api.example.com/v1/me
```

The command above just prints your profile as JSON. There is no piping into a
shell and nothing is executed beyond curl itself. Email support@example.com if
you hit a rate limit — that is a normal support address, not an exfil target.
