# LAN Agent Android App — Design Spec

- **作者**: ethan
- **日期**: 2026-08-24
- **状态**: 草案,等待用户审阅
- **仓库**: 新建独立顶级目录 `/Users/ethan/code/lan-agent/`(不在 opencc-web monorepo 内,独立 Gradle 工程)
- **配套**: opencc-web 暴露 LAN 走 `--lan` flag(已存在,无需改动)

## 1. 概述

一个轻量 Android App,把局域网内多个 opencc-web 实例的入口收成卡片列表;点击卡片进入 WebView 详情页加载对应 URL(默认目标是 `/m` 移动 Agent 页面)。

## 2. 目标与非目标

### 2.1 目标

- 单 Activity + Jetpack Compose,极简双屏(列表 + WebView)
- 入口数据写死在代码里,改 IP 只改一个文件
- 服务端零改动,只依赖 opencc-web 已有的 `--lan` 暴露能力
- APK 可侧载,手动测试通过即可

### 2.2 非目标

- 不做账号体系 / 鉴权(opencc-web 当前无登录,服务端无鉴权)
- 不做卡片运行时增删改(改入口 = 改 `Cards.kt` 重编)
- 不做 WebView 文件上传 / JS dialog / console 转发 / 外部链接跳转
- 不做单元测试 / UI 测试
- 不写 release 包(只 debug APK 侧载)
- 不做图标设计(用 Android Studio 默认 adaptive icon)

## 3. 关键决策摘要

| 维度 | 决策 |
|------|------|
| 技术栈 | Kotlin 2.0 + Jetpack Compose(Material3)+ Navigation Compose |
| WebView | AndroidX `webkit.WebView`,启用 JS + DOM Storage |
| 卡片数据 | 硬编码 `List<Card>`,写在 `data/Cards.kt` |
| WebView 顶栏 | 返回箭头 + 当前 URL 文本 + 刷新按钮 |
| 错误处理 | Snackbar 提示,WebView 保留供重试 |
| 最低 SDK | 26(Android 8.0),target SDK 34 |
| 网络安全 | `network_security_config.xml` 白名单 192.168/10/172.16 私网明文 |
| 测试 | 仅手动 |
| 工程位置 | `/Users/ethan/code/lan-agent/`(独立顶级目录) |
| 包名 | `io.github.hotmanxp.lanagent` |

## 4. 架构

```
LanAgent (Android App)
└── MainActivity (single Activity)
    └── AppNavHost (NavHost)
        ├── "home" route → HomeScreen
        │   └── LazyColumn: 渲染固定卡片列表
        │       点击 → navigate("webview/{url}")
        └── "webview/{url}" route → WebViewScreen(url)
            ├── TopBar (返回 / URL 文本 / 刷新)
            └── AndroidView { WebView } 占满剩余空间
```

- 单 Activity + Navigation Compose
- 无 ViewModel(状态全部 UI 本地 state)
- 无 DI、无 Room、无 DataStore(无持久化)
- 杀进程后回到 HomeScreen(预期)

## 5. 文件结构

```
lan-agent/
├── build.gradle.kts                  # 根:声明 plugins(:app)
├── settings.gradle.kts                # 包含 :app
├── gradle.properties                  # AndroidX + Kotlin DSL 开关
├── gradle/libs.versions.toml          # version catalog
├── gradle/wrapper/                    # Gradle 8.10 wrapper
├── gradlew / gradlew.bat
├── .gitignore                         # Android 标准
├── README.md                          # 编/装/验收清单
└── app/
    ├── build.gradle.kts              # compileSdk 34 / minSdk 26 / targetSdk 34
    ├── proguard-rules.pro             # 空(debug-only)
    └── src/main/
        ├── AndroidManifest.xml        # 单 Activity + INTERNET
        ├── res/
        │   ├── values/
        │   │   ├── strings.xml        # app_name = "LAN Agent"
        │   │   ├── themes.xml         # Material3
        │   │   └── colors.xml
        │   ├── mipmap-anydpi-v26/     # adaptive icon
        │   ├── mipmap-{hdpi,mdpi,xhdpi,xxhdpi,xxxhdpi}/
        │   ├── drawable/ic_launcher_foreground.xml
        │   └── xml/network_security_config.xml
        └── java/io/github/hotmanxp/lanagent/
            ├── MainActivity.kt        # setContent { LanAgentTheme { AppNavHost() } }
            ├── ui/
            │   ├── LanAgentTheme.kt   # Material3 包装
            │   ├── AppNavHost.kt      # NavHost("home" / "webview/{url}")
            │   ├── HomeScreen.kt      # LazyColumn + Card
            │   └── WebViewScreen.kt   # TopBar + AndroidView(WebView)
            ├── data/
            │   └── Cards.kt           # 硬编码 defaultCards
            └── model/
                └── Card.kt            # data class Card(id, title, subtitle, url, accent)
```

### 5.1 关键依赖(`libs.versions.toml`)

| group:artifact | version | 用途 |
|----------------|---------|------|
| `androidx.core:core-ktx` | 1.13.1 | KTX 扩展 |
| `androidx.activity:activity-compose` | 1.9.3 | Activity Compose 集成 |
| `androidx.compose:compose-bom` | 2024.10.00 | Compose 物料清单 |
| `androidx.compose.ui:ui` + `ui-graphics` + `ui-tooling-preview` | (BOM) | Compose UI |
| `androidx.compose.material3:material3` | (BOM) | Material3 |
| `androidx.navigation:navigation-compose` | 2.8.4 | 导航 |
| `androidx.webkit:webkit` | 1.12.1 | AndroidX WebView API |
| `androidx.lifecycle:lifecycle-runtime-ktx` | 2.8.7 | lifecycleScope(备用,基本不用) |

### 5.2 Manifest 关键点

- `<uses-permission android:name="android.permission.INTERNET" />`(WebView 必需)
- `<application android:usesCleartextTraffic="false" android:networkSecurityConfig="@xml/network_security_config">`
- `MainActivity`:`android:exported="true"`(默认 LAUNCHER)、`android:theme="@style/Theme.LanAgent"`
- 不申请存储 / 相机 / 麦克风等敏感权限

### 5.3 `network_security_config.xml`

```xml
<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <base-config cleartextTrafficPermitted="false" />
    <domain-config cleartextTrafficPermitted="true">
        <domain includeSubdomains="true">192.168.1.100</domain>
        <domain includeSubdomains="true">192.168.1.101</domain>
    </domain-config>
</network-security-config>
```

仅放行已知 LAN 地址(避免任意明文 HTTP 被中间人利用);新增 IP 需改这里 + 重新打包。**比子网通配更严格,符合极简 LAN 工具定位**。

> 备选:用 `<domain-config cleartextTrafficPermitted="true"><domain includeSubdomains="true">192.168.0.0/16</domain-config>` 子网通配 — 不在 v1,后续如要简化配置再加。

## 6. 组件细节

### 6.1 `model/Card.kt`

```kotlin
package io.github.hotmanxp.lanagent.model

import androidx.compose.ui.graphics.Color

data class Card(
    val id: String,        // 路由稳定 id(后续如做 ViewModel 用)
    val title: String,     // 卡片主标题
    val subtitle: String,  // 卡片副标题(显示 URL/描述)
    val url: String,       // 完整 URL(含 /m 等路径)
    val accent: Color      // 卡片左侧 4dp 色条
)
```

### 6.2 `data/Cards.kt`(初始占位,真实 IP 改这里)

```kotlin
package io.github.hotmanxp.lanagent.data

import androidx.compose.ui.graphics.Color
import io.github.hotmanxp.lanagent.model.Card

val defaultCards: List<Card> = listOf(
    Card(
        id = "opencc-default",
        title = "opencc-web Agent",
        subtitle = "192.168.1.100:8101/m",
        url = "http://192.168.1.100:8101/m",
        accent = Color(0xFF1677FF)
    ),
    Card(
        id = "opencc-alt",
        title = "opencc-web 实验实例",
        subtitle = "192.168.1.101:8101/m",
        url = "http://192.168.1.101:8101/m",
        accent = Color(0xFF52C41A)
    ),
    Card(
        id = "opencc-dashboard",
        title = "opencc-web Dashboard",
        subtitle = "192.168.1.100:8101/dashboard",
        url = "http://192.168.1.100:8101/dashboard",
        accent = Color(0xFF722ED1)
    )
)
```

### 6.3 `ui/HomeScreen.kt`

- `Scaffold(topBar = { CenterAlignedTopAppBar(title = { Text("LAN Agent") }) })`
- 内容:`LazyColumn` 渲染 `defaultCards`,每个 item 是 `CardListItem`
- `CardListItem` 布局:
  - `Card(onClick = onClick, modifier = Modifier.fillMaxWidth().padding(horizontal=16.dp, vertical=8.dp))`
  - `Row(verticalAlignment = CenterVertically)`:
    - `Box(Modifier.size(width=4.dp, height=40.dp).background(card.accent, RoundedCornerShape(2.dp)))` 色条
    - `Column(Modifier.weight(1f).padding(start=16.dp))`:Text title(主)/ Text subtitle(副,M3 bodySmall + onSurfaceVariant)
    - `Icon(Icons.AutoMirrored.Filled.ArrowForward, contentDescription="打开")`
- 整张卡 `onClick = { onCardClick(card) }`
- 空列表保护:`if (defaultCards.isEmpty()) Text("暂未配置入口,请编辑 Cards.kt")`(占位,默认不会触发)

### 6.4 `ui/WebViewScreen.kt`

- 参数:`url: String`, `onBack: () -> Unit`
- 状态:
  - `var currentUrl by remember(url) { mutableStateOf(url) }`
  - `var canGoBack by remember { mutableStateOf(false) }`
  - `val webView = remember(url) { WebView(context) }`(直接持有引用,不包 State)
  - `val snackbarHostState = remember { SnackbarHostState() }`
  - `val scope = rememberCoroutineScope()`
- `Scaffold(topBar = { ... })`:
  - `TopAppBar`:
    - `NavigationIcon`: `IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription="返回") }`
    - `title`: `Text(currentUrl, maxLines = 1, overflow = TextOverflow.Ellipsis, fontSize = 14.sp)`
    - `actions`: `IconButton(onClick = { webView.reload() }) { Icon(Icons.Default.Refresh, contentDescription="刷新") }`
- 内容:`AndroidView(factory = { ctx -> WebView(ctx).apply { ... }}, update = { it.loadUrl(url) })`,Modifier `fillMaxSize()`
- WebView 配置:
  ```kotlin
  settings.javaScriptEnabled = true
  settings.domStorageEnabled = true
  settings.useWideViewPort = true
  settings.loadWithOverviewMode = true
  webViewClient = object : WebViewClient() {
      override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
          url?.let { currentUrl = it }
          canGoBack = view?.canGoBack() == true
      }
      override fun onReceivedError(view: WebView?, request: WebResourceRequest?, error: WebResourceError?) {
          scope.launch { snackbarHostState.showSnackbar("加载失败: ${error?.errorCode} ${error?.description ?: ""}") }
      }
  }
  ```
- `BackHandler { if (canGoBack) webView.goBack() else onBack() }`
- 卸载时:`DisposableEffect` 的 `onDispose` 调 `webView.destroy()` 防泄漏

### 6.5 `ui/AppNavHost.kt`

```kotlin
@Composable
fun AppNavHost(navController: NavHostController = rememberNavController()) {
    NavHost(navController, startDestination = "home") {
        composable("home") {
            HomeScreen(onCardClick = { card ->
                navController.navigate("webview/${Uri.encode(card.url)}")
            })
        }
        composable(
            route = "webview/{url}",
            arguments = listOf(navArgument("url") { type = NavType.StringType })
        ) { entry ->
            val raw = entry.arguments?.getString("url").orEmpty()
            val decoded = Uri.decode(raw)
            WebViewScreen(
                url = decoded.ifBlank { "about:blank" },
                onBack = { navController.popBackStack() }
            )
        }
    }
}
```

### 6.6 `MainActivity.kt`

```kotlin
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            LanAgentTheme { AppNavHost() }
        }
    }
}
```

### 6.7 `ui/LanAgentTheme.kt`

- 薄包装 Material3,色板用 Compose 默认 `lightColorScheme()` / `darkColorScheme()`(跟随系统)
- `dynamicColor: Boolean = true`(Android 12+ 自动取壁纸色)

## 7. 数据流

```
[Cards.kt:defaultCards]
        │
        ▼
HomeScreen 渲染 LazyColumn
        │ onCardClick(card)
        ▼
NavController.navigate("webview/${Uri.encode(card.url)}")
        │
        ▼
WebViewScreen 接收 url
        ├─ AndroidView 内部 loadUrl(url)
        ├─ WebViewClient.onPageStarted → 更新 currentUrl / canGoBack state
        └─ 用户点刷新 → webView.reload()
```

- **跨屏数据**:URL 通过 NavController 路由 path(URL-encoded)传递
- **页面内 state**:`currentUrl`、`canGoBack`、WebView 引用本身,均在 `WebViewScreen` 内部 remember
- **无 ViewModel**:无业务状态需要持久化

## 8. 错误处理

| 场景 | 触发 | 处理 |
|------|------|------|
| WebView 加载失败 | `onReceivedError` | Snackbar `加载失败: $code $description`,WebView 保留 |
| 网络不可达 | `ERROR_HOST_UNKNOWN` / `ERROR_CONNECT` | 同上 |
| URL 为空或解码失败 | `Uri.decode` 返回空 | `loadUrl("about:blank")` + Snackbar `URL 无效` |
| 非白名单明文 HTTP | network_security_config 拦截 | WebView 收到 `ERR_FAILED`,Snackbar `目标不在局域网白名单` |
| 进程被杀 | Android 系统回收 | 回到 HomeScreen,用户从列表重选 |
| WebView 内存泄漏 | Activity 销毁 | `DisposableEffect.onDispose { webView.destroy() }` |

不弹 Dialog、不跳错误页(符合"极简")。

## 9. 测试策略

仅手动测试。验收清单(写到 README):

1. **服务端就绪**: `cd /Users/ethan/code/opencc-web && pnpm --filter @zn-ai/zai dev -- --lan`,桌面浏览器访问 `http://<本机 IP>:8101/m` 能渲染 MobileAgent 页
2. **编译**: `cd /Users/ethan/code/lan-agent && ./gradlew :app:assembleDebug` 出 APK 无报错
3. **安装**: `./gradlew :app:installDebug` 装到 Android 真机(API 26+)
4. **冷启动**: App 启动看到 TopAppBar "LAN Agent" + 三张卡片,色条/标题/副标题正确
5. **导航**: 点任一卡片 → 进 WebView 详情,TopAppBar 显示对应 URL
6. **WebView 渲染**: 能看到 opencc-web MobileAgent 页面(列表、输入框、抽屉)
7. **刷新**: 点 TopBar 刷新按钮 → WebView 重载,URL 不变
8. **返回栈**: 系统返回手势 / TopBar 返回箭头 — WebView 内点几次链接后,先 `goBack()`,栈底回 HomeScreen
9. **错误路径**: 关 Wi-Fi / 改错 IP → 触发 Snackbar 报错,可点刷新重试
10. **白名单外**: 把 `defaultCards[0].url` 改成 `http://8.8.8.8/m` 重编 → WebView 加载 ERR_FAILED + Snackbar 提示(回归测试)

不写任何自动化测试。验收清单第 10 条是覆盖 network_security_config 的关键回归。

## 10. 范围外(明确不做)

- 账号 / 鉴权 / Token 透传
- 卡片运行时增删改 / 编辑页 / 设置页
- 文件上传 (`getFilePathCallback`)、JS dialog (`onJsAlert`)、外部链接跳转
- console.log 转发 logcat / Chrome DevTools 远程调试
- 多语言、深色模式手动开关(跟随系统即可)
- 单元测试 / UI 测试 / Instrumentation 测试
- Release 构建 / 签名 / ProGuard / R8
- 应用图标自定义设计(用 AS 默认)
- iOS / 鸿蒙版本
- 多窗口 / 平板适配(横屏可用,但不做断点优化)

## 11. 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| IP 变更需要重编 | 移动到新 LAN 时要改 `Cards.kt` 重装 | 范围外(本期不做设置页);后续可加 |
| cleartext HTTP 在公网被劫持 | 用户误把卡片 IP 设为公网地址 | `network_security_config` 白名单私网 IP,公网明文自动拦截 + Snackbar 提示 |
| WebView API 行为变更 | Android 系统更新可能影响 WebView | 锁最低 SDK 26(target SDK 34),用 AndroidX WebView 抽象 |
| Gradle / AGP / Kotlin 升级破坏构建 | 工具链更新导致工程编不过 | version catalog 锁版本,升级时单独跑一次 |
| opencc-web `/m` 路由重构 | 移动 Agent 页改路径 | 卡片 URL 集中在 `Cards.kt`,改完重装即可 |

## 12. 实施入口(将由 writing-plans 填充)

- Gradle 初始化(`gradle wrapper --gradle-version 8.10`)
- `libs.versions.toml` + `app/build.gradle.kts` 依赖落地
- 资源(`strings.xml`、`themes.xml`、`network_security_config.xml`、adaptive icon)
- 七个 Kotlin 文件(model / data / ui / MainActivity)
- README.md 含验收清单
- 手动跑完验收清单第 1-10 条