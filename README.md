# MovieResolver API

API endpoint:

```txt
GET /movie/{number}
```

Example:

```txt
/movie/1726
```

It scans:

```txt
https://embed.filmu.in/movie/{number}
```

and returns only the first `/proxy/video?url=...` result as JSON.

## Local run

```bash
npm install
npm run install-browser
npm start
```

Open:

```txt
http://localhost:3000/movie/1726
```

## Render settings

```txt
Language: Docker
Dockerfile Path: ./Dockerfile
Docker Build Context Directory: .
Health Check Path: /healthz
Root Directory: blank if files are at repo root
```
