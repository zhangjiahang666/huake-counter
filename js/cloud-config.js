/* 划课 · 云服务配置（激活云服务时自动生成，请勿手改）
   仅含可公开的前端配置：标识应用 + 数据面地址，不含任何密钥权限；
   真正的安全边界在云端存储的账号隔离：每人只能读写自己账号下的文件。 */
window.PUBLIC_CLOUD_CONFIG = {
  resourceId: "wbcs_fEjEcuq5SKN4ET3riKgnNF",
  endpoint: "https://huake-counter.app.workbuddy.host",
  oauthRelayBaseUrl: "https://www.workbuddy.cn/v2/as/genie-baas/oauth",
  publishableKey: "wbpk_9V4QHIiQ4SgvNW7j44odjY_X3ZnVE7hFAO7glLOfcuTxiChTgXJhIg7",
  /* 云同步总开关：改为 true 并重新发布后，网站变为「登录后才能用」，
     各设备用同一个账号登录即可自动同步（数据存在 users/<uid>/huake/state.json）。
     为 false 时发布域名按本地模式运行（不弹登录门、不联网），与旧版行为一致。 */
  enabled: true
};
