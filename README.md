# CoreTaxDJP Mirror Proxy

Full mirror reverse proxy untuk `coretaxdjp.pajak.go.id` yang bisa di-deploy di VPS, Railway, Fly.io, Render, dan layanan sejenis.

## Fitur Anti-Duplikat (SEO)

Script ini mengatasi masalah **duplikat konten di Google Search Console** dengan cara:

1. **Canonical Tag** — Otomatis menghapus canonical tag asli dan menambahkan canonical tag yang mengarah ke domain proxy kamu
2. **URL Rewriting** — Semua URL internal (href, src, action, data-src, srcset, dll) di-rewrite ke domain proxy
3. **Meta Robots** — Menambahkan `<meta name="robots" content="index, follow" />`
4. **Open Graph / Twitter** — Rewrite `og:url`, `twitter:url`, `og:site_name` ke domain proxy
5. **Robots.txt** — Otomatis rewrite robots.txt dan menambahkan referensi sitemap
6. **CSS/JS Rewriting** — URL di dalam inline styles, `<style>` blocks, dan `<script>` blocks juga di-rewrite
7. **Redirect Rewriting** — Redirect dari server asli di-rewrite supaya tetap di domain proxy
8. **Cookie Domain Rewriting** — Cookie domain di-rewrite agar berfungsi di domain proxy
9. **JSON Rewriting** — Response JSON juga di-rewrite (termasuk escaped slashes)
10. **Referer/Origin** — Request header Referer dan Origin di-rewrite balik ke target saat request ke upstream

## Environment Variables

| Variable | Default | Keterangan |
|---|---|---|
| `PORT` | `3000` | Port server |
| `TARGET_HOST` | `coretaxdjp.pajak.go.id` | Hostname target yang di-mirror |
| `TARGET_PROTOCOL` | `https` | Protocol target |
| `YOUR_DOMAIN` | *(auto-detect)* | **PENTING:** Set ini ke domain kamu supaya canonical tag benar |

## Deploy

### VPS (Ubuntu/Debian)

```bash
# Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Clone & install
git clone https://github.com/fitrianabila2025group/coretaxdjp.git
cd coretaxdjp
npm install

# Set env & run
export YOUR_DOMAIN=coretaxdjp.yourdomain.com
export PORT=3000
node server.js

# Atau jalankan di background dengan PM2
npm install -g pm2
YOUR_DOMAIN=coretaxdjp.yourdomain.com pm2 start server.js --name coretaxdjp-mirror
pm2 save
pm2 startup
```

Setelah itu setup Nginx sebagai reverse proxy:

```nginx
server {
    listen 80;
    server_name coretaxdjp.yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
    }
}
```

Kemudian pasang SSL dengan Certbot:

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d coretaxdjp.yourdomain.com
```

### Railway

1. Push repo ke GitHub
2. Buka [railway.app](https://railway.app), connect repo
3. Set environment variables:
   - `YOUR_DOMAIN` = domain custom kamu (atau domain Railway yang diberikan)
4. Deploy otomatis

### Fly.io

```bash
# Install flyctl
curl -L https://fly.io/install.sh | sh

# Login & deploy
fly auth login
fly launch  # ikuti prompt
fly deploy

# Set custom domain
fly certs add yourdomain.com

# Set env
fly secrets set YOUR_DOMAIN=yourdomain.com
```

### Render

1. Push repo ke GitHub
2. Buka [render.com](https://render.com), create new Web Service
3. Connect repo, pilih Docker
4. Set environment variables:
   - `YOUR_DOMAIN` = domain kamu
5. Deploy

### Docker (di mana saja)

```bash
docker build -t coretaxdjp-mirror .
docker run -d -p 3000:3000 \
  -e YOUR_DOMAIN=coretaxdjp.yourdomain.com \
  coretaxdjp-mirror
```

## Tips SEO untuk Menghindari Duplikat

1. **Selalu set `YOUR_DOMAIN`** — Ini adalah kunci utama agar canonical tag benar
2. **Submit sitemap** — Di Google Search Console, submit URL sitemap dari domain kamu
3. **Gunakan HTTPS** — Pastikan domain proxy kamu menggunakan HTTPS
4. **Tunggu indexing** — Setelah deploy, minta indexing ulang di Google Search Console
5. **Cek canonical** — Buka halaman mirror kamu, View Source, pastikan `<link rel="canonical">` mengarah ke domain kamu, BUKAN ke `coretaxdjp.pajak.go.id`