@echo off
net use Y: "\\Simonas\home" /persistent:no >nul 2>&1
cd /d "Y:\Project Zomboid\VSCode\pz-room-furnisher\PZ-Room-Furnisher\frontend"
npm run dev

