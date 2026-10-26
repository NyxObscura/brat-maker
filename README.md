sudo apt install ttf-mscorefonts-installer
fc-cache -fv


npm install --omit=dev
mkdir -p logs
pm2 start ecosystem.config.cjs --env production
pm2 save && pm2 startup


# 1. Buat file swap sebesar 8GB
sudo fallocate -l 8G /swapfile

# 2. Ubah permission agar file aman (hanya root yang bisa baca/tulis)
sudo chmod 600 /swapfile

# 3. Format file tersebut menjadi partisi swap
sudo mkswap /swapfile

# 4. Aktifkan swap-nya sekarang juga
sudo swapon /swapfile

# 5. Daftarkan ke fstab agar swap otomatis aktif setiap VPS di-restart
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# Ubah swappiness saat ini menjadi 10
sudo sysctl vm.swappiness=10

# Simpan konfigurasi secara permanen agar bertahan setelah restart
echo 'vm.swappiness=10' | sudo tee -a /etc/sysctl.conf

GIT IGNORE
