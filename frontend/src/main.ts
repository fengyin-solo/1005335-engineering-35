import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router'
import { bootstrapSeed } from './data/local-store'
import './styles/global.css'

// 先跑播种引导（拉取 seed-snapshot.json，版本变化时自动重灌 localStorage），再挂载应用。
bootstrapSeed()
  .catch((error) => {
    console.error('[seed] 播种引导失败，使用代码内置种子：', error)
  })
  .finally(() => {
    const app = createApp(App)
    app.use(createPinia())
    app.use(router)
    app.mount('#app')
  })
