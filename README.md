# 划课 · 课时计数器

一个纯前端的多页面小应用：用来数课时——瑜伽卡、游泳卡、各种课包，划一节少一节，快用完会变红提醒。数据存在浏览器本地，支持多设备云同步，无需后端服务器。

## 功能

- **课时卡**：两种类型
  - 📖 课时——按节计数，逐节划掉
  - 📦 课包——记录总价与购买日期，自动算「剩余价值」
- **文件夹分组**：卡片可归入文件夹，支持筛选、重命名、删除（删文件夹不删卡）
- **批量管理**：多选后批量移动到文件夹、上移/下移排序；也支持直接拖拽
- **搜索**：按卡名 / 备注实时过滤，与文件夹筛选叠加
- **加减课记录**：每次划掉/加课写历史（含上课日期、备注），可单条撤销
- **收据附件**：每张卡可挂收据图片 / CSV 表格，图片上传前自动压缩
- **统计**：仪表盘看总剩余、本月消耗、各卡占比
- **深色模式**、**导入导出**（JSON 备份 / Excel）
- **多设备同步**：登录同一个账号，电脑 / 手机 / iPad 自动同步同一份数据
- **PWA**：可添加到手机主屏，全屏使用、离线可用

## 本地运行

纯静态站点，没有任何构建步骤：

```bash
# 方式一：直接用浏览器打开
open index.html            # macOS
start index.html           # Windows

# 方式二：起个本地服务器（推荐，行为与线上一致）
python3 scripts/serve.py   # 然后访问 http://localhost:8000
```

`scripts/serve.py` 还附带一个局域网模式：手机连同一 Wi-Fi 访问打印出的地址，即可与电脑共用一份数据（无需登录）。

## 测试

```bash
npm install jsdom --no-save
node scripts/smoke_test.js
```

225 项断言覆盖：四页加载、数据流、文件夹、搜索、批量管理、课包、导入导出、云同步（桩 SDK）、PWA 文件等。推送到 GitHub 时会自动跑（见 `.github/workflows/`）。

## 目录结构

```
index.html  cards.html  history.html  settings.html  sell.html   # 页面
css/style.css                                                    # 全站样式（CSS 变量 + 深色模式）
js/app.js                                                        # 全部逻辑（页面感知，按元素存在性分发渲染）
js/cloud-config.js                                               # 云同步开关与配置（不含密钥）
sw.js  manifest.webmanifest  icon-*.png                          # PWA
scripts/serve.py                                                 # 本地/局域网服务器
scripts/smoke_test.js                                            # jsdom 冒烟测试
scripts/gen_favicon.js                                           # 图标生成（纯 Node，无依赖）
scripts/check_links.py                                           # 断链检查
```

## 数据与隐私

- 数据默认只存在**当前浏览器的 localStorage**，不清缓存不丢。
- 开启云同步后，数据以私有文件形式存在你自己的账号下（`users/<uid>/huake/state.json`），按账号隔离。
- 仓库里没有任何密钥；导入的备份文件完全由你本地掌控。

## 在线地址

- 主站（支持云同步）：https://huake-counter.app.workbuddy.host/
- GitHub Pages 镜像（本地模式）：https://zhangjiahang666.github.io/huake-counter/
