@echo off
chcp 65001 >nul 2>&1
setlocal enabledelayedexpansion

:: =============================================================================
:: zn-env - 知鸟 AI CLI 环境管理工具 (Windows 版本)
:: =============================================================================

set "NPM_REGISTRY=http://maven.paic.com.cn/repository/npm/"

:: 颜色定义 (使用 ANSI 颜色码)
set "RED=[91m"
set "GREEN=[92m"
set "YELLOW=[93m"
set "BLUE=[94m"
set "CYAN=[96m"
set "MAGENTA=[95m"
set "BOLD=[1m"
set "DIM=[2m"
set "NC=[0m"

:: Emoji 定义
set "EMOJI_CHECK=?"
set "EMOJI_CROSS=✗"
set "EMOJI_INFO=ℹ"
set "EMOJI_QUESTION=?"
set "EMOJI_ROCKET=?"
set "EMOJI_TOOL=?"
set "EMOJI_PACKAGE=?"
set "EMOJI_KEY=?"
set "EMOJI_SETTINGS=?"
set "EMOJI_QUIT=?"

:: =============================================================================
:: 辅助函数
:: =============================================================================

:print_header
    echo.
    echo  ╔════════════════════════════════════════════════════════════════╗
    echo  ║           知鸟 AI CLI 环境管理工具                              ║
    echo  ╚════════════════════════════════════════════════════════════════╝
    echo.
    goto :eof

:print_section
    echo.
    echo  --- %~1 ---
    echo.
    goto :eof

:print_info
    echo  %BLUE%%EMOJI_INFO% %DIM%%~1%NC%
    goto :eof

:print_success
    echo  %GREEN%%EMOJI_CHECK% %~1%NC%
    goto :eof

:print_error
    echo  %RED%%EMOJI_CROSS% %~1%NC%
    goto :eof

:print_warning
    echo  %YELLOW%? %~1%NC%
    goto :eof

:print_step
    echo  %CYAN%? %~1%NC%
    goto :eof

:wait_key
    echo.
    pause >nul
    goto :eof

:confirm
    set "result="
    echo.
    set /p "result=%~1 (y/N): "
    if /i "!result!"=="y" (
        exit /b 0
    ) else (
        exit /b 1
    )

:: =============================================================================
:: 包管理器检测
:: =============================================================================

:get_installed_pkg_manager
    set "cmd=%~1"
    set "pkg_manager=npm"

    :: 检查 npm
    where npm >nul 2>&1
    if !errorlevel! equ 0 (
        npm list -g --depth=0 2>nul | findstr /i "%cmd%" >nul
        if !errorlevel! equ 0 (
            set "pkg_manager=npm"
            exit /b 0
        )
    )

    :: 检查 pnpm
    where pnpm >nul 2>&1
    if !errorlevel! equ 0 (
        pnpm list -g --depth=0 2>nul | findstr /i "%cmd%" >nul
        if !errorlevel! equ 0 (
            set "pkg_manager=pnpm"
            exit /b 0
        )
    )

    :: 检查 yarn
    where yarn >nul 2>&1
    if !errorlevel! equ 0 (
        yarn global list 2>nul | findstr /i "%cmd%" >nul
        if !errorlevel! equ 0 (
            set "pkg_manager=yarn"
            exit /b 0
        )
    )

    set "pkg_manager=npm"
    exit /b 0

:install_global_pkg
    set "pkg=%~1"
    set "pkg_manager=%~2"

    if "!pkg_manager!"=="pnpm" (
        call pnpm add -g "%pkg%" --registry="%NPM_REGISTRY%"
    ) else if "!pkg_manager!"=="yarn" (
        call yarn global add "%pkg%" --registry="%NPM_REGISTRY%"
    ) else (
        call npm install -g "%pkg%" --registry="%NPM_REGISTRY%"
    )
    exit /b 0

:: =============================================================================
:: 系统信息
:: =============================================================================

:show_system_info
    call :print_section 系统信息

    :: Node.js 版本
    call :print_step Node.js 版本
    where node >nul 2>&1
    if !errorlevel! equ 0 (
        for /f "delims=" %%v in ('node --version') do set "node_version=%%v"
        echo   版本: !node_version!
        set "major=!node_version:~1,2!"
        if !major! geq 20 (
            call :print_success 满足要求 ^(>= 20^)
        ) else (
            call :print_error 需要 Node.js 20+
        )
    ) else (
        call :print_error 未安装 Node.js
    )

    :: npm 版本
    call :print_step npm 版本
    where npm >nul 2>&1
    if !errorlevel! equ 0 (
        for /f "delims=" %%v in ('npm --version') do set "npm_version=%%v"
        echo   版本: !npm_version!
    ) else (
        call :print_error 未安装 npm
    )

    :: npm prefix
    call :print_step npm 全局路径
    for /f "delims=" %%p in ('npm config get prefix 2^>nul') do set "npm_prefix=%%p"
    echo   prefix: !npm_prefix!

    :: npm registry
    call :print_step npm 镜像源
    for /f "delims=" %%r in ('npm config get registry 2^>nul') do set "npm_registry=%%r"
    echo   registry: !npm_registry!

    echo.
    goto :eof

:show_cli_status
    call :print_section CLI 工具安装状态

    :: Nova CLI
    call :print_step Nova CLI ^(@zn-ai/nova^)
    where nova >nul 2>&1
    if !errorlevel! equ 0 (
        for /f "delims=" %%p in ('where nova') do set "nova_path=%%p"
        echo   命令: nova ^(!nova_path!^)
        call :print_success 已安装
    ) else (
        call :print_error 未安装
    )

    :: OpenCode
    call :print_step OpenCode CLI ^(opencode-ai^)
    where opencode >nul 2>&1
    if !errorlevel! equ 0 (
        for /f "delims=" %%p in ('where opencode') do set "opencode_path=%%p"
        echo   命令: opencode ^(!opencode_path!^)
        call :print_success 已安装
    ) else (
        call :print_error 未安装
    )

    :: OpenCC
    call :print_step OpenCC ^(@zn-ai/opencc^)
    where opencc >nul 2>&1
    if !errorlevel! equ 0 (
        for /f "delims=" %%p in ('where opencc') do set "opencc_path=%%p"
        echo   命令: opencc ^(!opencc_path!^)
        call :print_success 已安装
    ) else (
        call :print_error 未安装
    )

    :: agent-login
    call :print_step agent-login ^(@zn-ai/agent-login^)
    echo   使用方式: npx @zn-ai/agent-login@latest
    call :print_info 通过 npx 方式使用，无需全局安装

    echo.
    goto :eof

:count_items_in_dir
    set "dir_path=%~1"
    set "count=0"
    if exist "!dir_path!" (
        for /f %%i in ('dir /b /a "!dir_path!" 2^>nul ^| find /c /v ""') do set "count=%%i"
    )
    exit /b 0

:show_directory_status
    call :print_section CLI 工具资源状态

    :: Nova CLI
    call :print_step Nova CLI
    set "nova_dir=%USERPROFILE%\.nova"
    echo   路径: !nova_dir!
    if exist "!nova_dir!" (
        :: Agents
        set "nova_agents=!nova_dir!\agents"
        call :count_items_in_dir "!nova_agents!"
        echo   Agents: !count! 个
        if exist "!nova_agents!" (
            dir /b "!nova_agents!" 2>nul
        )

        :: Commands
        set "nova_cmds=!nova_dir!\commands"
        call :count_items_in_dir "!nova_cmds!"
        echo   Commands: !count! 个

        :: Plugins/Extensions
        set "nova_ext=!nova_dir!\extensions"
        if exist "!nova_ext!" (
            for /f %%i in ('dir /b /ad "!nova_ext!" 2^>nul ^| find /c /v ""') do set "ext_count=%%i"
            echo   Plugins: !ext_count! 个
        ) else (
            echo   Plugins: 0 个
        )
    ) else (
        echo   Agents: 0 个
        echo   Commands: 0 个
        echo   Plugins: 0 个
    )
    echo.

    :: OpenCode
    call :print_step OpenCode
    set "opencode_dir=%APPDATA%\opencode"
    echo   路径: !opencode_dir!
    if exist "!opencode_dir!" (
        :: Agents
        set "opencode_agents=!opencode_dir!\agents"
        call :count_items_in_dir "!opencode_agents!"
        echo   Agents: !count! 个

        :: Commands
        set "opencode_cmds=!opencode_dir!\commands"
        call :count_items_in_dir "!opencode_cmds!"
        echo   Commands: !count! 个
    ) else (
        echo   Agents: 0 个
        echo   Commands: 0 个
    )
    echo.

    :: OpenCC
    call :print_step OpenCC
    set "opencc_dir=%USERPROFILE%\.claude"
    echo   路径: !opencc_dir!
    if exist "!opencc_dir!" (
        :: Agents
        set "opencc_agents=!opencc_dir!\agents"
        call :count_items_in_dir "!opencc_agents!"
        echo   Agents: !count! 个

        :: Commands
        set "opencc_cmds=!opencc_dir!\commands"
        call :count_items_in_dir "!opencc_cmds!"
        echo   Commands: !count! 个
    ) else (
        echo   Agents: 0 个
        echo   Commands: 0 个
    )
    echo.

    :: Global Skills
    call :print_step 全局 Skills ^(共享^)
    set "skills_dir=%USERPROFILE%\.agents\skills"
    echo   路径: !skills_dir!
    if exist "!skills_dir!" (
        for /f %%i in ('dir /b /ad "!skills_dir!" 2^>nul ^| find /c /v ""') do set "skill_count=%%i"
        echo   Skills: !skill_count! 个
    ) else (
        echo   Skills: 0 个
    )

    echo.
    goto :eof

:show_npm_packages
    call :print_section 已安装的 npm 包

    where npm >nul 2>&1
    if !errorlevel! equ 0 (
        call :print_step 全局安装的包
        echo.
        npm list -g --depth=0 2>nul | findstr /i "@zn-ai opencode"
    )
    echo.
    call :print_info agent-login: npx @zn-ai/agent-login@latest
    echo.
    goto :eof

:show_all_system_info
    cls
    call :print_header
    call :show_system_info
    call :show_cli_status
    call :show_directory_status
    call :wait_key
    goto :eof

:: =============================================================================
:: 工具安装
:: =============================================================================

:install_nova_cli
    call :print_section 安装/更新 Nova CLI
    call :get_installed_pkg_manager "nova"
    call :print_step 检测到使用: !pkg_manager!
    call :print_step 安装 Nova CLI...
    call :install_global_pkg "@zn-ai/nova" "!pkg_manager!"
    where nova >nul 2>&1
    if !errorlevel! equ 0 (
        call :print_success Nova CLI 安装/更新成功!
    ) else (
        call :print_error 安装失败，请检查配置
    )
    call :wait_key
    goto :eof

:install_opencode_cli
    call :print_section 安装/更新 OpenCode CLI
    call :get_installed_pkg_manager "opencode"
    call :print_step 检测到使用: !pkg_manager!
    call :print_step 安装 OpenCode CLI...
    call :install_global_pkg "opencode-ai" "!pkg_manager!"
    where opencode >nul 2>&1
    if !errorlevel! equ 0 (
        call :print_success OpenCode CLI 安装/更新成功!
    ) else (
        call :print_error 安装失败，请检查配置
    )
    call :wait_key
    goto :eof

:install_opencc
    call :print_section 安装/更新 OpenCC
    call :get_installed_pkg_manager "opencc"
    call :print_step 检测到使用: !pkg_manager!
    call :print_step 安装 OpenCC...
    call :install_global_pkg "@zn-ai/opencc" "!pkg_manager!"
    where opencc >nul 2>&1
    if !errorlevel! equ 0 (
        call :print_success OpenCC 安装/更新成功!
    ) else (
        call :print_error 安装失败，请检查配置
    )
    call :wait_key
    goto :eof

:install_agent_login
    call :print_section 安装 agent-login
    call :print_info agent-login 通过 npx 方式使用，无需全局安装
    call :print_info 所有登录命令会自动使用最新版本

    :: 验证 npx 可用
    where npx >nul 2>&1
    if !errorlevel! equ 0 (
        call :print_step 验证 @zn-ai/agent-login@latest 可访问...
        npx @zn-ai/agent-login@latest --version >nul 2>&1
        if !errorlevel! equ 0 (
            call :print_success agent-login 可用
        ) else (
            call :print_warning 请确保网络连接正常
        )
    ) else (
        call :print_error 需要 npx 命令
    )

    call :wait_key
    goto :eof

:install_all_tools
    call :print_section 安装所有 CLI 工具
    call :confirm "将安装 Nova CLI、OpenCode CLI 和 OpenCC？"
    if !errorlevel! equ 0 (
        call :install_nova_cli
        call :install_opencode_cli
        call :install_opencc
        call :print_success 所有工具安装完成!
        call :print_info agent-login 使用 npx @zn-ai/agent-login@latest 方式
        call :wait_key
    )
    goto :eof

:: =============================================================================
:: 资源安装
:: =============================================================================

:list_available_resources
    set "type=%~1"

    if "!type!"=="skills" (
        call :print_section 可用 Skills
        echo.
        npx @zn-ai/plugin@latest list skills 2>nul || call :print_error 获取 Skills 列表失败
    ) else if "!type!"=="commands" (
        call :print_section 可用 Commands
        echo.
        npx @zn-ai/plugin@latest list commands 2>nul || call :print_error 获取 Commands 列表失败
    ) else if "!type!"=="plugins" (
        call :print_section 可用 Plugins ^(Extensions^)
        echo.
        npx @zn-ai/plugin@latest list extensions 2>nul || call :print_error 获取 Plugins 列表失败
    ) else if "!type!"=="agents" (
        call :print_section 可用 Agents
        echo.
        npx @zn-ai/plugin@latest list agents 2>nul || call :print_error 获取 Agents 列表失败
    )
    goto :eof

:browse_and_install_resource
    set "type=%~1"

    cls
    call :print_header

    if "!type!"=="skills" echo    浏览 Skills
    if "!type!"=="commands" echo   浏览 Commands
    if "!type!"=="plugins" echo   浏览 Plugins
    if "!type!"=="agents" echo   浏览 Agents
    echo.
    echo.

    call :list_available_resources "!type!"

    echo.
    echo   %DIM%输入资源名称安装，输入 0 返回%NC%
    echo.
    set "resource_name="
    set /p "resource_name=请输入: "

    if "!resource_name!"=="0" goto :eof
    if "!resource_name!"=="" goto :eof

    call :print_step 安装 !resource_name!...

    if "!type!"=="skills" (
        npx @zn-ai/plugin@latest install skills "!resource_name!" 2>&1 || call :print_error 安装失败
    ) else if "!type!"=="commands" (
        npx @zn-ai/plugin@latest install commands "!resource_name!" 2>&1 || call :print_error 安装失败
    ) else if "!type!"=="plugins" (
        npx @zn-ai/plugin@latest install extensions "!resource_name!" 2>&1 || call :print_error 安装失败
    ) else if "!type!"=="agents" (
        npx @zn-ai/plugin@latest install agents "!resource_name!" 2>&1 || call :print_error 安装失败
    )
    call :wait_key
    goto :eof

:: =============================================================================
:: 登录命令
:: =============================================================================

:login_pa
    call :print_section PA 神兵登录
    call :print_step 执行 npx @zn-ai/agent-login@latest pa...
    npx @zn-ai/agent-login@latest pa
    call :wait_key
    goto :eof

:login_openplatform
    call :print_section 开放平台登录
    call :print_step 执行 npx @zn-ai/agent-login@latest op...
    npx @zn-ai/agent-login@latest op
    call :wait_key
    goto :eof

:login_openplatform_stg
    call :print_section 开放平台登录 ^(测试环境^)
    call :print_step 执行 npx @zn-ai/agent-login@latest op --stg...
    npx @zn-ai/agent-login@latest op --stg
    call :wait_key
    goto :eof

:: =============================================================================
:: 工具配置
:: =============================================================================

:: 检测可用的编辑器
:detect_editor
    set "editor="
    where code >nul 2>&1
    if !errorlevel! equ 0 (
        set "editor=code"
        exit /b 0
    )
    where notepad >nul 2>&1
    if !errorlevel! equ 0 (
        set "editor=notepad"
        exit /b 0
    )
    exit /b 0

:: 通用的配置文件打开函数
:open_or_init_config
    set "config_file=%~1"
    set "tool_name=%~2"
    set "default_content=%~3"

    if exist "!config_file!" (
        call :print_info 配置文件: !config_file!
        call :detect_editor
        if defined editor (
            call :print_step 使用 !editor! 打开...
            start "" "!editor!" "!config_file!"
        ) else (
            call :print_warning 未检测到可用编辑器
            call :print_info 请手动打开: !config_file!
        )
    ) else (
        call :print_warning 配置文件不存在
        call :confirm "是否创建默认配置？"
        if !errorlevel! equ 0 (
            for /f "delims=" %%d in ('dirname "!config_file!"') do set "config_dir=%%d"
            if not exist "!config_dir!" mkdir "!config_dir!"
            (
                echo !default_content!
            ) > "!config_file!"
            call :print_success 默认配置已创建: !config_file!
            call :detect_editor
            if defined editor (
                call :print_step 使用 !editor! 打开...
                start "" "!editor!" "!config_file!"
            ) else (
                call :print_warning 未检测到可用编辑器
                call :print_info 请手动打开: !config_file!
            )
        )
    )
    exit /b 0

:config_nova_settings
    call :print_section 配置 Nova
    set "config_file=%USERPROFILE%\.nova\settings.json"

    :: Nova 默认配置
    set "default_config={"
    set "default_config=!default_config!  ^^"env^^": {"
    set "default_config=!default_config!    ^^"ANTHROPIC_AUTH_TOKEN^^": ^^"^^","
    set "default_config=!default_config!    ^^"ANTHROPIC_BASE_URL^^": ^^"https://zn-nova.paic.com.cn/novai^^","
    set "default_config=!default_config!    ^^"ANTHROPIC_MODEL^^": ^^"qwen3.6-plus^^","
    set "default_config=!default_config!    ^^"ANTHROPIC_SMALL_FAST_MODEL^^": ^^"MiniMax-M2.7-highspeed^^","
    set "default_config=!default_config!    ^^"ANTHROPIC_DEFAULT_SONNET_MODEL^^": ^^"glm-5^^","
    set "default_config=!default_config!    ^^"ANTHROPIC_DEFAULT_OPUS_MODEL^^": ^^"glm-5.1^^","
    set "default_config=!default_config!    ^^"ANTHROPIC_DEFAULT_HAIKU_MODEL^^": ^^"MiniMax-M2.7-highspeed^^""
    set "default_config=!default_config!  }"
    set "default_config=!default_config!}"

    call :open_or_init_config "!config_file!" "Nova" "!default_config!"
    call :wait_key
    goto :eof

:config_opencode_settings
    call :print_section 配置 OpenCode
    set "opencode_dir=%APPDATA%\opencode"
    set "config_file=!opencode_dir!\opencode.json"

    if exist "!opencode_dir!" (
        if exist "!config_file!" (
            call :print_info 配置文件: !config_file!
            call :detect_editor
            if defined editor (
                call :print_step 使用 !editor! 打开...
                start "" "!editor!" "!config_file!"
            ) else (
                call :print_warning 未检测到可用编辑器
                call :print_info 请手动打开: !config_file!
            )
        ) else (
            call :print_warning 配置文件不存在
            call :print_info OpenCode 会在首次运行时自动创建配置
            call :detect_editor
            if defined editor (
                call :print_step 使用 !editor! 打开配置目录...
                start "" "!editor!" "!opencode_dir!"
            ) else (
                call :print_warning 未检测到可用编辑器
                call :print_info 请手动打开: !opencode_dir!
            )
        )
    ) else (
        call :print_warning 配置文件不存在
        call :print_info OpenCode 会在首次运行时自动创建配置
        call :print_step 创建配置目录...
        mkdir "!opencode_dir!" 2>nul
        call :detect_editor
        if defined editor (
            call :print_step 使用 !editor! 打开配置目录...
            start "" "!editor!" "!opencode_dir!"
        ) else (
            call :print_warning 未检测到可用编辑器
            call :print_info 请手动打开: !opencode_dir!
        )
    )

    call :wait_key
    goto :eof

:config_opencc_settings
    call :print_section 配置 OpenCC
    set "config_file=%USERPROFILE%\.claude\settings.json"

    :: OpenCC 默认配置
    set "default_config={"
    set "default_config=!default_config!  ^^"env^^": {"
    set "default_config=!default_config!    ^^"ANTHROPIC_AUTH_TOKEN^^": ^^"^^","
    set "default_config=!default_config!    ^^"API_TIMEOUT_MS^^": ^^"3000000^^","
    set "default_config=!default_config!    ^^"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC^^": ^^"1^^","
    set "default_config=!default_config!    ^^"ANTHROPIC_BASE_URL^^": ^^"https://zn-nova.paic.com.cn/novai^^","
    set "default_config=!default_config!    ^^"ANTHROPIC_MODEL^^": ^^"qwen3.6-plus^^","
    set "default_config=!default_config!    ^^"ANTHROPIC_SMALL_FAST_MODEL^^": ^^"MiniMax-M2.7-highspeed^^","
    set "default_config=!default_config!    ^^"ANTHROPIC_DEFAULT_SONNET_MODEL^^": ^^"glm-5^^","
    set "default_config=!default_config!    ^^"ANTHROPIC_DEFAULT_OPUS_MODEL^^": ^^"glm-5.1^^","
    set "default_config=!default_config!    ^^"ANTHROPIC_DEFAULT_HAIKU_MODEL^^": ^^"MiniMax-M2.7-highspeed^^""
    set "default_config=!default_config!  }"
    set "default_config=!default_config!}"

    call :open_or_init_config "!config_file!" "OpenCC" "!default_config!"
    call :wait_key
    goto :eof

:show_env_guide
    call :print_section 环境配置指南
    echo.
    echo  ┌─────────────────────────────────────────────────────────────┐
    echo  │                      环境配置步骤                           │
    echo  └─────────────────────────────────────────────────────────────┘
    echo.
    echo  1. 配置 npm 镜像源 ^(本工具已提供^)
    echo     npm config set registry http://maven.paic.com.cn/repository/npm/
    echo.
    echo  2. 安装 CLI 工具 ^(本工具已提供^)
    echo     npm install -g @zn-ai/nova
    echo     npm install -g opencode-ai
    echo     npm install -g @zn-ai/opencc
    echo     npm install -g @zn-ai/agent-login@latest
    echo.
    echo  3. 登录 ^(本工具已提供^)
    echo     npx @zn-ai/agent-login@latest pa      # PA 神兵登录
    echo     npx @zn-ai/agent-login@latest op      # 开放平台登录
    echo.
    echo  4. OpenCode 配置插件 ^(本工具已提供^)
    echo     cd ^%~dp0..
///
///..\opencode
    echo     npm init -y
    echo     npm install @zn-ai/agent-login@latest
    echo     # 添加插件到 opencode.json
    echo.
    echo  5. OpenCC 配置 ^(本工具已提供^)
    echo     # 创建 ~\.claude\settings.json
    echo     # 配置 ANTHROPIC_BASE_URL 和模型
    echo.
    echo 详细文档: docs/AI_CLI_SETUP.md
    echo.
    call :wait_key
    goto :eof

:: =============================================================================
:: 快速启动
:: =============================================================================

:quick_start
    call :print_section 快速启动
    echo 正在检查环境...
    echo.

    :: 检查 Node.js
    where node >nul 2>&1
    if !errorlevel! neq 0 (
        call :print_error 缺少必要环境: Node.js
        call :print_info 请先安装 Node.js: https://nodejs.org/
        call :wait_key
        goto :eof
    )

    :: 检查 npm
    where npm >nul 2>&1
    if !errorlevel! neq 0 (
        call :print_error 缺少必要环境: npm
        call :wait_key
        goto :eof
    )

    :: 检查并安装工具
    call :print_step 检查 CLI 工具...
    set "to_install="

    where nova >nul 2>&1
    if !errorlevel! neq 0 set "to_install=!to_install! @zn-ai/nova"
    where opencode >nul 2>&1
    if !errorlevel! neq 0 set "to_install=!to_install! opencode-ai"
    where opencc >nul 2>&1
    if !errorlevel! neq 0 set "to_install=!to_install! @zn-ai/opencc"

    if defined to_install (
        call :print_warning 发现未安装的工具: !to_install!
        call :confirm "是否自动安装？"
        if !errorlevel! equ 0 (
            for %%p in (!to_install!) do (
                call :print_step 安装 %%p...
                call npm install -g %%p --registry="!NPM_REGISTRY!" >nul 2>&1
            )
        )
    ) else (
        call :print_success 所有 CLI 工具已安装
    )

    :: 配置
    call :print_step 配置 npm 镜像源...
    call npm config set registry "!NPM_REGISTRY!" >nul 2>&1
    call :print_success 完成

    echo.
    call :print_success 快速启动完成!
    call :print_info 下一步: 运行登录命令进行登录
    call :wait_key
    goto :eof

:: =============================================================================
:: 主菜单
:: =============================================================================

:show_menu
    cls
    call :print_header

    :: 基础信息
    echo   基础信息
    where node >nul 2>&1
    if !errorlevel! equ 0 (
        for /f "delims=" %%v in ('node --version') do set "node_version=%%v"
        echo     Node.js: !node_version!
    ) else (
        echo     Node.js: 未安装
    )

    :: CLI 状态
    set "cli_list="
    where nova >nul 2>&1
    if !errorlevel! equ 0 set "cli_list=!cli_list!%MAGENTA%Nova%NC% "
    where opencode >nul 2>&1
    if !errorlevel! equ 0 set "cli_list=!cli_list!%GREEN%OpenCode%NC% "
    where opencc >nul 2>&1
    if !errorlevel! equ 0 set "cli_list=!cli_list!%YELLOW%OpenCC%NC% "

    if defined cli_list (
        echo     CLI: !cli_list!
    ) else (
        echo     CLI: 未安装
    )

    echo.
    echo   请选择操作:
    echo.
    echo     1. ? PA 神兵登录
    echo     2. ? 开放平台登录
    echo     3. ? 资源安装
    echo     4. ? 工具安装
    echo     5. ? 系统信息
    echo     6. ? 工具配置
    echo     7. ? 快速启动
    echo     8. ? 退出
    echo.
    goto :eof

:: =============================================================================
:: 子菜单
:: =============================================================================

:show_install_menu
    cls
    call :print_header
    echo   工具安装/更新
    echo.
    echo     1. 安装/更新 Nova CLI
    echo     2. 安装/更新 OpenCode CLI
    echo     3. 安装/更新 OpenCC
    echo     4. 安装/更新所有工具
    echo     5. 返回主菜单
    echo.
    set /p "choice=请选择 (1-5): "

    if "!choice!"=="1" call :install_nova_cli
    if "!choice!"=="2" call :install_opencode_cli
    if "!choice!"=="3" call :install_opencc
    if "!choice!"=="4" call :install_all_tools
    goto :eof

:show_resource_menu
    cls
    call :print_header
    echo   资源安装
    echo.
    echo     1. 浏览 Skills
    echo     2. 浏览 Commands
    echo     3. 浏览 Plugins
    echo     4. 浏览 Agents
    echo     5. 返回主菜单
    echo.
    set /p "choice=请选择 (1-5): "

    if "!choice!"=="1" call :browse_and_install_resource "skills"
    if "!choice!"=="2" call :browse_and_install_resource "commands"
    if "!choice!"=="3" call :browse_and_install_resource "plugins"
    if "!choice!"=="4" call :browse_and_install_resource "agents"
    goto :eof

:show_config_menu
    cls
    call :print_header
    echo   工具配置
    echo.
    echo     1. 配置 Nova
    echo     2. 配置 OpenCode
    echo     3. 配置 OpenCC
    echo     4. 返回主菜单
    echo.
    set /p "choice=请选择 (1-4): "

    if "!choice!"=="1" call :config_nova_settings
    if "!choice!"=="2" call :config_opencode_settings
    if "!choice!"=="3" call :config_opencc_settings
    goto :eof

:: =============================================================================
:: 主程序
:: =============================================================================

:main
    :menu_loop
    call :show_menu
    set /p "choice=请选择 (1-8): "

    if "!choice!"=="1" call :login_pa
    if "!choice!"=="2" call :login_openplatform
    if "!choice!"=="3" call :show_resource_menu
    if "!choice!"=="4" call :show_install_menu
    if "!choice!"=="5" call :show_all_system_info
    if "!choice!"=="6" call :show_config_menu
    if "!choice!"=="7" call :quick_start
    if "!choice!"=="8" goto :exit_program

    goto :menu_loop

    :exit_program
    echo.
    echo  感谢使用!
    echo.
    endlocal
    exit /b 0

:: 运行
call :main
