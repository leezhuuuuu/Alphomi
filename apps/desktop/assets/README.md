# 应用图标和资源

这个文件夹包含应用的图标和 DMG 背景图片。

## 所需文件

### 图标文件
- `icon.icns` - macOS 应用图标 (512x512px)
- `icon.ico` - Windows 应用图标 (256x256px)
- `icon.png` - Linux 应用图标 (512x512px)

### DMG 背景
- `dmg-background.png` - macOS DMG 安装窗口背景 (600x400px)

## 如何创建图标

### 1. 使用在线工具
推荐使用在线图标转换工具：
- https://favicon.io/favicon-converter/
- https://convertico.com/

上传一个 512x512 的 PNG 图片，选择下载 ICO 和 ICNS 格式。

### 2. 使用命令行工具

如果有 ImageMagick：
```bash
# 创建 PNG 版本 (512x512)
convert icon.png -resize 512x512 apps/desktop/assets/icon.png

# 创建 ICO 版本
convert icon.png -resize 256x256 apps/desktop/assets/icon.ico

# 创建 ICNS 版本 (需要 macOS)
iconutil -c icns icon.iconset -o apps/desktop/assets/icon.icns
```

### 3. 使用 macOS 工具

在 macOS 上，可以使用 Preview 应用调整图片大小并导出不同格式。

## DMG 背景图片

建议使用简洁的图片，包含应用 logo 和简单的拖拽说明文字。
尺寸：600x400 像素

## 临时解决方案

如果暂时没有图标文件，electron-builder 会使用默认图标。
打包命令仍然可以正常工作。