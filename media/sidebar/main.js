;(function () {
  const vscode = acquireVsCodeApi()
  const AUTO_REFRESH_INTERVAL = 5 * 60 * 1000
  const REFRESH_COOLDOWN = 5000

  // 从 VSCode 持久化状态中恢复折叠状态
  const previousState = vscode.getState()

  const state = {
    configs: [],
    templates: [],
    formVisible: false,
    formMode: 'create',
    editingId: null,
    lastRefresh: 0,
    loading: false,
    refreshing: false,
    collapsedCards: new Set(previousState?.collapsedCards || []), // 从持久化状态恢复
    autoRefreshTimer: null, // 自动刷新定时器
    isVisible: true // 面板是否可见
  }

  const configSection = document.getElementById('config-section')
  const configList = document.getElementById('config-list')
  const configForm = document.getElementById('config-form')
  const toastEl = document.getElementById('toast')
  const refreshBtn = document.getElementById('refresh-all')
  const toggleFormBtn = document.getElementById('toggle-form')
  const formSection = document.getElementById('form-section')
  const formTitle = document.getElementById('form-title')
  const formSubmitBtn = document.getElementById('form-submit')
  const cancelFormBtn = document.getElementById('cancel-form')
  const templateSelector = document.getElementById('template-selector')
  const claudeSettingsInput = document.getElementById('claude-preview')
  const codexAuthInput = document.getElementById('codex-auth-preview')
  const codexTomlInput = document.getElementById('codex-toml-preview')
  let previewLock = false

  const fields = {
    id: configForm?.querySelector('[name="configId"]'),
    name: configForm?.querySelector('[name="name"]'),
    website: configForm?.querySelector('[name="website"]'),
    statusUrl: configForm?.querySelector('[name="statusUrl"]'),
    statusAuthorization: configForm?.querySelector('[name="statusAuthorization"]'),
    statusUserId: configForm?.querySelector('[name="statusUserId"]'),
    statusCookie: configForm?.querySelector('[name="statusCookie"]'),
    claude: {
      baseUrl: configForm?.querySelector('[name="claudeBaseUrl"]'),
      apiKey: configForm?.querySelector('[name="claudeApiKey"]')
    },
    codex: {
      baseUrl: configForm?.querySelector('[name="codexBaseUrl"]'),
      apiKey: configForm?.querySelector('[name="codexApiKey"]')
    },
    codexConfigBase: document.getElementById('codex-config-base')
  }

  window.addEventListener('message', event => {
    const { type, payload } = event.data || {}

    if (type === 'state') {
      state.configs = Array.isArray(payload) ? payload : []
      state.loading = false
      state.refreshing = false
      renderConfigs()
      updateLoadingUI()
    }

    if (type === 'templates') {
      state.templates = Array.isArray(payload) ? payload : []
      renderTemplateOptions()
    }

    if (type === 'configDetail') {
      openForm('edit', payload)
      showToast('已载入配置，可继续编辑')
    }

    if (type === 'visibilityChange') {
      handleVisibilityChange(payload.visible)
    }
  })

  Object.values(fields).forEach(field => {
    if (!field) {
      return
    }

    if (field instanceof HTMLElement && field.tagName === 'INPUT') {
      field.addEventListener('input', updatePreviewContent)
      field.addEventListener('change', updatePreviewContent)
      return
    }

    if (typeof field === 'object') {
      Object.values(field).forEach(input => {
        input?.addEventListener('input', updatePreviewContent)
        input?.addEventListener('change', updatePreviewContent)
      })
    }
  })

  configForm?.addEventListener('submit', event => {
    event.preventDefault()

    let basePayload
    try {
      basePayload = readPayloadFromFields({ strict: true })
    } catch (error) {
      const message = error instanceof Error ? error.message : '配置校验失败'
      showToast(message)
      return
    }

    const isEdit = state.formMode === 'edit' && state.editingId
    const message = {
      type: isEdit ? 'updateConfig' : 'addConfig',
      payload: isEdit ? { ...basePayload, id: state.editingId } : basePayload
    }

    vscode.postMessage(message)
    showToast(isEdit ? '已提交更新' : '已提交新配置')
    closeForm()
  })

  refreshBtn?.addEventListener('click', () => tryRequestRefresh('manual'))

  toggleFormBtn?.addEventListener('click', () => {
    if (state.formVisible && state.formMode === 'create') {
      closeForm()
    } else {
      openForm('create')
    }
  })

  cancelFormBtn?.addEventListener('click', () => closeForm())

  templateSelector?.addEventListener('change', event => {
    const templateName = event.target.value
    if (!templateName) {
      // 选择"自定义"，清空表单
      return
    }
    const template = state.templates.find(t => t.name === templateName)
    if (template) {
      applyTemplate(template)
    }
  })

  claudeSettingsInput?.addEventListener('input', () => {
    if (state.formMode === 'edit' || state.formMode === 'create') {
      applyClaudeSettingsFromPreview()
    }
  })

  codexAuthInput?.addEventListener('input', () => {
    if (state.formMode === 'edit' || state.formMode === 'create') {
      applyCodexAuthFromPreview()
    }
  })

  codexTomlInput?.addEventListener('input', () => {
    if (state.formMode === 'edit' || state.formMode === 'create') {
      applyCodexTomlFromPreview()
    }
  })

  function tryRequestRefresh(source) {
    const now = Date.now()
    if (now - state.lastRefresh < REFRESH_COOLDOWN) {
      showToast('刷新过于频繁，请至少间隔 5 秒')
      return
    }
    state.lastRefresh = now
    state.refreshing = true
    updateLoadingUI()
    vscode.postMessage({ type: 'refreshAll' })
    showToast(source === 'manual' ? '正在刷新配置…' : '刷新中…')
  }

  function handleVisibilityChange(visible) {
    state.isVisible = visible

    if (visible) {
      // 面板变为可见时，立即刷新一次并启动定时器
      tryRequestRefresh('visibility')
    } else {
      // 面板隐藏时，停止定时器
      stopAutoRefresh()
    }
  }

  function stopAutoRefresh() {
    if (state.autoRefreshTimer) {
      clearInterval(state.autoRefreshTimer)
      state.autoRefreshTimer = null
    }
  }

  function renderTemplateOptions() {
    if (!templateSelector) {
      return
    }

    // 保留"自定义"选项，添加模板选项
    const currentValue = templateSelector.value
    templateSelector.innerHTML = '<option value="">自定义</option>'

    state.templates.forEach(template => {
      const option = document.createElement('option')
      option.value = template.name
      option.textContent = template.name
      templateSelector.appendChild(option)
    })

    // 恢复之前的选择（如果存在）
    if (currentValue) {
      templateSelector.value = currentValue
    }
  }

  function applyTemplate(template) {
    if (!template) {
      return
    }

    // 填充基本信息
    if (fields.name) {
      fields.name.value = template.name || ''
    }
    if (fields.website) {
      fields.website.value = template.website || ''
    }

    // 填充状态查询配置
    if (fields.statusUrl) {
      fields.statusUrl.value = template.status?.url || ''
    }
    if (fields.statusAuthorization) {
      fields.statusAuthorization.value = template.status?.authorization || ''
    }
    if (fields.statusUserId) {
      fields.statusUserId.value = template.status?.userId || ''
    }
    if (fields.statusCookie) {
      fields.statusCookie.value = template.status?.cookie || ''
    }

    // 填充 Claude 配置
    if (template.claude && claudeSettingsInput) {
      claudeSettingsInput.value = template.claude.settingsJson || ''
      applyClaudeSettingsFromPreview()
    }

    // 填充 Codex 配置
    if (template.codex) {
      if (codexAuthInput) {
        codexAuthInput.value = template.codex.authJson || ''
        applyCodexAuthFromPreview()
      }
      if (codexTomlInput) {
        const tomlContent = template.codex.configToml || ''

        // 提取 model_provider
        const providerMatch = tomlContent.match(/^\s*model_provider\s*=\s*"([^"]+)"/m)

        if (providerMatch && fields.codex?.baseUrl) {
          const providerName = providerMatch[1]
          // 构建正则表达式匹配 [model_providers.xxx] 部分的 base_url
          const sectionRegex = new RegExp(
            `\\[model_providers\\.${providerName.replace(
              /[.*+?^${}()|[\]\\]/g,
              '\\$&'
            )}\\][\\s\\S]*?base_url\\s*=\\s*"([^"]+)"`,
            'i'
          )
          const baseUrlMatch = tomlContent.match(sectionRegex)

          if (baseUrlMatch) {
            // 填充 base_url 到输入框
            fields.codex.baseUrl.value = baseUrlMatch[1]

            // 从 TOML 中移除 [model_providers.xxx] 部分的 base_url
            const lines = tomlContent.split('\n')
            const result = []
            let inProviderSection = false

            for (const line of lines) {
              if (
                new RegExp(
                  `\\[model_providers\\.${providerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]`,
                  'i'
                ).test(line)
              ) {
                inProviderSection = true
                result.push(line)
                continue
              }

              if (inProviderSection && /^\s*\[/.test(line)) {
                inProviderSection = false
              }

              // 跳过 [model_providers.xxx] 中的 base_url
              if (inProviderSection && /^\s*base_url\s*=/.test(line)) {
                continue
              }

              result.push(line)
            }

            codexTomlInput.value = result.join('\n').trim()
          } else {
            // 没有找到 base_url,保留原配置
            codexTomlInput.value = tomlContent
          }
        } else {
          // 如果没有 model_provider,整个作为自定义配置
          codexTomlInput.value = tomlContent
        }
      }
    }

    // 触发预览更新
    updatePreviewContent()
    showToast(`已应用模板：${template.name}`)
  }

  function openForm(mode, config) {
    state.formMode = mode
    state.formVisible = true
    state.editingId = mode === 'edit' && config?.id ? config.id : null
    setFormVisibility(true)
    fillForm(config)
    updateFormTexts(mode, config)
    configSection?.classList.add('hidden')
  }

  function closeForm() {
    state.formVisible = false
    state.editingId = null
    state.formMode = 'create'
    configForm?.reset()
    resetPreviews()
    setFormVisibility(false)
    updateFormTexts('create')
    configSection?.classList.remove('hidden')
    // 重置模板选择器
    if (templateSelector) {
      templateSelector.value = ''
    }
  }

  function setFormVisibility(visible) {
    if (!formSection) {
      return
    }

    formSection.classList.toggle('hidden', !visible)
    formSection.setAttribute('aria-hidden', String(!visible))
    toggleFormBtn?.setAttribute('aria-expanded', String(visible))
    if (visible) {
      formSection.scrollIntoView({ behavior: 'smooth', block: 'start' })
      fields.name?.focus()
    }
    if (toggleFormBtn) {
      toggleFormBtn.textContent = visible && state.formMode === 'create' ? '收起表单' : '新增配置'
    }
  }

  function updateFormTexts(mode, config) {
    if (formTitle) {
      formTitle.textContent = mode === 'edit' && config ? `编辑 ${config.name} 配置` : '新增配置'
    }
    if (formSubmitBtn) {
      formSubmitBtn.textContent = mode === 'edit' ? '保存修改' : '保存配置'
    }
  }

  function fillForm(config) {
    if (!configForm) {
      return
    }

    if (!config) {
      configForm.reset()
    }

    if (fields.id) {
      fields.id.value = config?.id ?? ''
    }
    if (fields.name) {
      fields.name.value = config?.name ?? ''
    }
    if (fields.website) {
      fields.website.value = config?.website ?? ''
    }
    if (fields.statusUrl) {
      fields.statusUrl.value = config?.status?.url ?? ''
    }
    if (fields.statusAuthorization) {
      fields.statusAuthorization.value = config?.status?.authorization ?? ''
    }
    if (fields.statusUserId) {
      fields.statusUserId.value = config?.status?.userId ?? ''
    }
    if (fields.statusCookie) {
      fields.statusCookie.value = config?.status?.cookie ?? ''
    }

    setEndpointFields('claude', config?.claude)
    setEndpointFields('codex', config?.codex)
    if (claudeSettingsInput) {
      claudeSettingsInput.value = config?.claudeSettings || ''
    }
    if (codexAuthInput) {
      codexAuthInput.value = config?.codexAuth || ''
    }
    if (codexTomlInput) {
      // 剥离 base_url 行（如果存在），只保留用户自定义配置部分
      const rawConfig = config?.codexConfig || ''
      const strippedConfig = stripBaseUrlFromToml(rawConfig)
      codexTomlInput.value = strippedConfig || defaultCodexToml()
    }
    updatePreviewContent()
  }

  function setEndpointFields(type, endpoint) {
    const target = fields[type]
    if (!target) {
      return
    }
    if (target.baseUrl) {
      target.baseUrl.value = endpoint?.baseUrl ?? ''
    }
    target.apiKey.value = endpoint?.apiKey ?? ''
  }

  function renderConfigs() {
    if (!configList) {
      return
    }

    configList.innerHTML = ''

    // 显示 loading 或空状态
    if (state.loading) {
      const loadingItem = document.createElement('li')
      loadingItem.className = 'empty-state loading-state'
      loadingItem.innerHTML = '<div class="spinner"></div><p>正在加载配置...</p>'
      configList.appendChild(loadingItem)
      return
    }

    if (state.configs.length === 0) {
      const emptyItem = document.createElement('li')
      emptyItem.className = 'empty-state'
      emptyItem.innerHTML = '<p>暂无配置</p><p class="hint">点击右上角"新增配置"开始使用</p>'
      configList.appendChild(emptyItem)
      return
    }

    state.configs.forEach(config => {
      const item = document.createElement('li')
      item.className = 'config-card'
      item.dataset.configId = config.id

      const header = document.createElement('div')
      header.className = 'config-header'

      // 添加折叠按钮
      const collapseBtn = document.createElement('button')
      collapseBtn.type = 'button'
      collapseBtn.className = 'collapse-btn ghost'
      collapseBtn.innerHTML = '<span class="collapse-icon">▼</span>'
      collapseBtn.title = '展开/收起'
      collapseBtn.addEventListener('click', () => toggleCardCollapse(item))

      const title = document.createElement('div')
      title.className = 'config-title'

      const titleText = document.createElement('span')
      titleText.className = 'config-title-text'
      titleText.textContent = config.name

      const iconsContainer = document.createElement('span')
      iconsContainer.className = 'config-title-icons'

      // 添加 Claude 图标（如果有配置）
      if (config.claude?.baseUrl) {
        const claudeIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
        claudeIcon.setAttribute('viewBox', '0 0 24 24')
        claudeIcon.setAttribute('fill', 'currentColor')
        claudeIcon.setAttribute(
          'title',
          config.claude.isActive ? 'Claude (已启用)' : 'Claude (未启用)'
        )
        if (config.claude.isActive) {
          claudeIcon.classList.add('active')
        }
        claudeIcon.innerHTML =
          '<path d="M11.376 24L10.776 23.544L10.44 22.8L10.776 21.312L11.16 19.392L11.472 17.856L11.76 15.96L11.928 15.336L11.904 15.288L11.784 15.312L10.344 17.28L8.16 20.232L6.432 22.056L6.024 22.224L5.304 21.864L5.376 21.192L5.784 20.616L8.16 17.568L9.6 15.672L10.536 14.592L10.512 14.448H10.464L4.128 18.576L3 18.72L2.496 18.264L2.568 17.52L2.808 17.28L4.704 15.96L9.432 13.32L9.504 13.08L9.432 12.96H9.192L8.4 12.912L5.712 12.84L3.384 12.744L1.104 12.624L0.528 12.504L0 11.784L0.048 11.424L0.528 11.112L1.224 11.16L2.736 11.28L5.016 11.424L6.672 11.52L9.12 11.784H9.504L9.552 11.616L9.432 11.52L9.336 11.424L6.96 9.84L4.416 8.16L3.072 7.176L2.352 6.672L1.992 6.216L1.848 5.208L2.496 4.488L3.384 4.56L3.6 4.608L4.488 5.304L6.384 6.768L8.88 8.616L9.24 8.904L9.408 8.808V8.736L9.24 8.472L7.896 6.024L6.456 3.528L5.808 2.496L5.64 1.872C5.576 1.656 5.544 1.416 5.544 1.152L6.288 0.144001L6.696 0L7.704 0.144001L8.112 0.504001L8.736 1.92L9.72 4.152L11.28 7.176L11.736 8.088L11.976 8.904L12.072 9.168H12.24V9.024L12.36 7.296L12.6 5.208L12.84 2.52L12.912 1.752L13.296 0.840001L14.04 0.360001L14.616 0.624001L15.096 1.32L15.024 1.752L14.76 3.6L14.184 6.504L13.824 8.472H14.04L14.28 8.208L15.264 6.912L16.92 4.848L17.64 4.032L18.504 3.12L19.056 2.688H20.088L20.832 3.816L20.496 4.992L19.44 6.336L18.552 7.464L17.28 9.168L16.512 10.536L16.584 10.632H16.752L19.608 10.008L21.168 9.744L22.992 9.432L23.832 9.816L23.928 10.2L23.592 11.016L21.624 11.496L19.32 11.952L15.888 12.768L15.84 12.792L15.888 12.864L17.424 13.008L18.096 13.056H19.728L22.752 13.272L23.544 13.8L24 14.424L23.928 14.928L22.704 15.528L21.072 15.144L17.232 14.232L15.936 13.92H15.744V14.016L16.848 15.096L18.84 16.896L21.36 19.224L21.48 19.8L21.168 20.28L20.832 20.232L18.624 18.552L17.76 17.808L15.84 16.2H15.72V16.368L16.152 17.016L18.504 20.544L18.624 21.624L18.456 21.96L17.832 22.176L17.184 22.056L15.792 20.136L14.376 17.952L13.224 16.008L13.104 16.104L12.408 23.352L12.096 23.712L11.376 24Z" shape-rendering="optimizeQuality" fill="#D97757"></path>'
        iconsContainer.appendChild(claudeIcon)
      }

      // 添加 Codex 图标（如果有配置）
      if (config.codex?.baseUrl) {
        const codexIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
        codexIcon.setAttribute('viewBox', '0 0 156 154')
        codexIcon.setAttribute('fill', 'none')
        codexIcon.setAttribute('title', config.codex.isActive ? 'Codex (已启用)' : 'Codex (未启用)')
        if (config.codex.isActive) {
          codexIcon.classList.add('active')
        }
        codexIcon.innerHTML =
          '<path d="M59.7325 56.1915V41.6219C59.7325 40.3948 60.1929 39.4741 61.266 38.8613L90.5592 21.9915C94.5469 19.6912 99.3013 18.6181 104.208 18.6181C122.612 18.6181 134.268 32.8813 134.268 48.0637C134.268 49.1369 134.268 50.364 134.114 51.5911L103.748 33.8005C101.908 32.7274 100.067 32.7274 98.2267 33.8005L59.7325 56.1915ZM128.133 112.937V78.1222C128.133 75.9745 127.212 74.441 125.372 73.3678L86.878 50.9768L99.4538 43.7682C100.527 43.1554 101.448 43.1554 102.521 43.7682L131.814 60.6381C140.25 65.5464 145.923 75.9745 145.923 86.0961C145.923 97.7512 139.023 108.487 128.133 112.935V112.937ZM50.6841 82.2638L38.1083 74.9028C37.0351 74.29 36.5748 73.3693 36.5748 72.1422V38.4025C36.5748 21.9929 49.1506 9.5696 66.1744 9.5696C72.6162 9.5696 78.5962 11.7174 83.6585 15.5511L53.4461 33.0352C51.6062 34.1084 50.6855 35.6419 50.6855 37.7897V82.2653L50.6841 82.2638ZM77.7533 97.9066L59.7325 87.785V66.3146L77.7533 56.193L95.7725 66.3146V87.785L77.7533 97.9066ZM89.3321 144.53C82.8903 144.53 76.9103 142.382 71.848 138.549L102.06 121.064C103.9 119.991 104.821 118.458 104.821 116.31V71.8343L117.551 79.1954C118.624 79.8082 119.084 80.7289 119.084 81.956V115.696C119.084 132.105 106.354 144.529 89.3321 144.529V144.53ZM52.9843 110.33L23.6911 93.4601C15.2554 88.5517 9.58181 78.1237 9.58181 68.0021C9.58181 56.193 16.6365 45.611 27.5248 41.163V76.1299C27.5248 78.2776 28.4455 79.8111 30.2854 80.8843L68.6271 103.121L56.0513 110.33C54.9781 110.943 54.0574 110.943 52.9843 110.33ZM51.2983 135.482C33.9681 135.482 21.2384 122.445 21.2384 106.342C21.2384 105.115 21.3923 103.888 21.5448 102.661L51.7572 120.145C53.5971 121.218 55.4385 121.218 57.2784 120.145L95.7725 97.9081V112.478C95.7725 113.705 95.3122 114.625 94.239 115.238L64.9458 132.108C60.9582 134.408 56.2037 135.482 51.2969 135.482H51.2983ZM89.3321 153.731C107.889 153.731 123.378 140.542 126.907 123.058C144.083 118.61 155.126 102.507 155.126 86.0976C155.126 75.3617 150.525 64.9336 142.243 57.4186C143.01 54.1977 143.471 50.9768 143.471 47.7573C143.471 25.8267 125.68 9.41567 105.129 9.41567C100.989 9.41567 97.0011 10.0285 93.0134 11.4095C86.1112 4.66126 76.6024 0.367188 66.1744 0.367188C47.6171 0.367188 32.1282 13.5558 28.5994 31.0399C11.4232 35.4879 0.380859 51.5911 0.380859 68.0006C0.380859 78.7365 4.98133 89.1645 13.2631 96.6795C12.4963 99.9004 12.036 103.121 12.036 106.341C12.036 128.271 29.8265 144.682 50.3777 144.682C54.5178 144.682 58.5055 144.07 62.4931 142.689C69.3938 149.437 78.9026 153.731 89.3321 153.731Z" fill="currentColor"></path>'
        iconsContainer.appendChild(codexIcon)
      }

      title.appendChild(titleText)
      if (iconsContainer.children.length > 0) {
        title.appendChild(iconsContainer)
      }

      header.appendChild(collapseBtn)
      header.appendChild(title)

      if (config.hasStatusConfig && config.lastStatus.status === 401) {
        // 认证过期
        const authExpired = document.createElement('div')
        authExpired.className = 'header-status status-critical'
        authExpired.textContent = '认证过期'
        header.appendChild(authExpired)
      } else if (config.hasStatusConfig && config.lastStatus?.ok) {
        const usageTokens = parseFloat(config.lastStatus.usage || 0)
        const balanceTokens = parseFloat(config.lastStatus.balance || 0)
        const totalTokens = parseFloat(config.lastStatus.total || 0) || usageTokens + balanceTokens

        // 只有当总量大于0时才显示（避免显示 $0.00/$0.00）
        if (totalTokens > 0) {
          const remainingPercent = (balanceTokens / totalTokens) * 100

          const divisor = config.lastStatus.quotaPerUnit || 1000000
          const formatUSD = tokens => {
            if (!tokens) return '$0.00'
            const dollars = parseFloat(tokens) / divisor
            return `$${dollars.toFixed(2)}`
          }

          // 根据剩余百分比选择圆形指示器和颜色
          let circleChar = '○'
          let colorClass = 'status-good'
          if (remainingPercent > 80) {
            circleChar = '○'
            colorClass = 'status-good'
          } else if (remainingPercent > 60) {
            circleChar = '◔'
            colorClass = 'status-good'
          } else if (remainingPercent > 40) {
            circleChar = '◑'
            colorClass = 'status-medium'
          } else if (remainingPercent > 20) {
            circleChar = '◕'
            colorClass = 'status-warning'
          } else {
            circleChar = '●'
            colorClass = 'status-critical'
          }

          const headerUsage = document.createElement('div')
          headerUsage.className = 'header-usage-compact'

          const indicator = document.createElement('span')
          indicator.className = `usage-indicator ${colorClass}`
          indicator.textContent = circleChar
          indicator.title = `剩余 ${remainingPercent.toFixed(1)}%`

          const balanceText = document.createElement('span')
          balanceText.className = 'usage-balance'
          balanceText.textContent = `${formatUSD(String(usageTokens))}/${formatUSD(
            String(totalTokens)
          )}`

          headerUsage.appendChild(indicator)
          headerUsage.appendChild(balanceText)
          header.appendChild(headerUsage)
        }
      }

      // 将详细内容包裹在可折叠容器中
      const detailsContainer = document.createElement('div')
      detailsContainer.className = 'card-details'

      const endpoints = document.createElement('div')
      endpoints.className = 'endpoint-overview'
      ;['claude', 'codex'].forEach(type => {
        const summary = config[type]
        const row = document.createElement('div')
        row.className = 'endpoint-item'

        const label = document.createElement('span')
        label.className = 'endpoint-label'
        label.textContent = type === 'claude' ? 'Claude' : 'Codex'

        const value = document.createElement('span')
        value.className = 'endpoint-value'
        value.textContent = summary?.baseUrl ?? '未配置'

        const actionWrap = document.createElement('div')
        actionWrap.className = 'endpoint-actions'

        const activateBtn = document.createElement('button')
        activateBtn.type = 'button'
        if (!summary) {
          activateBtn.textContent = '未配置'
          activateBtn.disabled = true
        } else {
          activateBtn.textContent = summary.isActive ? '已启用' : '启用'
          activateBtn.className = summary.isActive ? 'primary' : 'secondary'
          activateBtn.disabled = summary.isActive
          if (!summary.isActive) {
            activateBtn.addEventListener('click', () => handleActivateConfig(config.id, type))
          }
        }

        actionWrap.appendChild(activateBtn)
        row.appendChild(label)
        row.appendChild(value)
        row.appendChild(actionWrap)
        endpoints.appendChild(row)
      })

      // 操作按钮区域（编辑、删除、官网）
      const actionsFooter = document.createElement('div')
      actionsFooter.className = 'actions-footer'

      const editBtn = document.createElement('button')
      editBtn.type = 'button'
      editBtn.textContent = '编辑'
      editBtn.className = 'ghost'
      editBtn.addEventListener('click', () => handleEditConfig(config.id))
      actionsFooter.appendChild(editBtn)

      const deleteBtn = document.createElement('button')
      deleteBtn.type = 'button'
      deleteBtn.textContent = '删除'
      deleteBtn.className = 'danger'
      deleteBtn.addEventListener('click', () => handleDeleteConfig(config.id))
      actionsFooter.appendChild(deleteBtn)

      if (config.website) {
        const websiteBtn = document.createElement('button')
        websiteBtn.type = 'button'
        websiteBtn.textContent = '打开官网'
        websiteBtn.className = 'ghost'
        websiteBtn.addEventListener('click', () => handleOpenWebsite(config.id))
        actionsFooter.appendChild(websiteBtn)
      }

      // 将所有详细内容添加到容器中
      detailsContainer.appendChild(endpoints)
      detailsContainer.appendChild(actionsFooter)

      item.appendChild(header)
      item.appendChild(detailsContainer)

      // 恢复折叠状态
      if (state.collapsedCards.has(config.id)) {
        item.classList.add('collapsed')
      }

      configList.appendChild(item)
    })
  }

  function toggleCardCollapse(cardElement) {
    const configId = cardElement.dataset.configId
    const isCollapsed = cardElement.classList.toggle('collapsed')

    // 保存折叠状态到内存
    if (isCollapsed) {
      state.collapsedCards.add(configId)
    } else {
      state.collapsedCards.delete(configId)
    }

    // 持久化到 VSCode Webview 状态(跨会话保留)
    vscode.setState({
      collapsedCards: Array.from(state.collapsedCards)
    })
  }

  /**
   * 合并 Codex config.toml，将 base_url 写入 [model_providers.xxx] 部分
   * @param {string} baseUrl - 用户输入的 base_url
   * @param {string} customToml - 用户自定义的 TOML 配置
   * @returns {string} 合并后的完整 TOML 配置
   */
  function mergeCodexConfigToml(baseUrl, customToml) {
    if (!customToml) {
      // 如果没有自定义配置，生成基本模板
      // 使用默认 provider 名称 "custom"
      return `model_provider = "custom"

[model_providers.custom]
name = "custom"
base_url = "${baseUrl}"
wire_api = "responses"
requires_openai_auth = true`
    }

    // 提取 model_provider 值
    const providerMatch = customToml.match(/^\s*model_provider\s*=\s*"([^"]+)"/m)
    if (!providerMatch) {
      // 如果没有 model_provider，添加默认的并在末尾添加 [model_providers.custom] 部分
      return `model_provider = "custom"

${customToml}

[model_providers.custom]
name = "custom"
base_url = "${baseUrl}"
wire_api = "responses"
requires_openai_auth = true`
    }

    const providerName = providerMatch[1]
    const sectionHeader = `[model_providers.${providerName}]`

    // 检查是否已存在 [model_providers.xxx] 部分
    const sectionRegex = new RegExp(
      `\\[model_providers\\.${providerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]`,
      'i'
    )
    const hasSectionHeader = sectionRegex.test(customToml)

    if (hasSectionHeader) {
      // 已存在 [model_providers.xxx]，需要更新或添加 base_url
      const lines = customToml.split('\n')
      const result = []
      let inProviderSection = false
      let baseUrlUpdated = false

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]

        // 检测是否进入 [model_providers.xxx] 部分
        if (sectionRegex.test(line)) {
          inProviderSection = true
          result.push(line)
          continue
        }

        // 检测是否离开当前部分（遇到新的 [section]）
        if (inProviderSection && /^\s*\[/.test(line)) {
          // 如果还没更新 base_url，在离开部分前添加
          if (!baseUrlUpdated) {
            result.push(`base_url = "${baseUrl}"`)
            baseUrlUpdated = true
          }
          inProviderSection = false
        }

        // 如果在 [model_providers.xxx] 部分中，替换 base_url
        if (inProviderSection && /^\s*base_url\s*=/.test(line)) {
          result.push(`base_url = "${baseUrl}"`)
          baseUrlUpdated = true
          continue
        }

        result.push(line)
      }

      // 如果到达文件末尾还没更新 base_url，追加到末尾
      if (inProviderSection && !baseUrlUpdated) {
        result.push(`base_url = "${baseUrl}"`)
      }

      return result.join('\n')
    } else {
      // 不存在 [model_providers.xxx]，在末尾添加新部分
      return `${customToml}

${sectionHeader}
name = "${providerName}"
base_url = "${baseUrl}"
wire_api = "responses"
requires_openai_auth = true`
    }
  }

  function readPayloadFromFields(options) {
    options = options || {}
    const strict = Boolean(options.strict)

    const name = (fields.name?.value || '').trim()
    const website = (fields.website?.value || '').trim()
    const statusUrl = (fields.statusUrl?.value || '').trim()
    const statusAuthorization = (fields.statusAuthorization?.value || '').trim()
    const statusUserId = (fields.statusUserId?.value || '').trim()
    const statusCookie = (fields.statusCookie?.value || '').trim()

    const claude = buildEndpointPayload(fields.claude, 'Claude', strict)
    const codex = buildEndpointPayload(fields.codex, 'Codex', strict)

    // 合并 Codex config.toml：将 base_url 写入 [model_providers.xxx] 部分
    let codexConfigFull = ''
    if (codex && codex.baseUrl) {
      const customToml = (codexTomlInput?.value || '').trim()
      codexConfigFull = mergeCodexConfigToml(codex.baseUrl, customToml)
    }

    return {
      name,
      website: website || undefined,
      status:
        statusUrl || statusAuthorization || statusUserId || statusCookie
          ? {
              url: statusUrl || undefined,
              authorization: statusAuthorization || undefined,
              userId: statusUserId || undefined,
              cookie: statusCookie || undefined
            }
          : undefined,
      claude,
      codex,
      claudeSettings: claudeSettingsInput?.value || '',
      codexAuth: codexAuthInput?.value || '',
      codexConfig: codexConfigFull
    }
  }

  function buildEndpointPayload(endpointFields, label, strict) {
    if (!endpointFields) {
      return undefined
    }
    const baseUrl = (endpointFields.baseUrl?.value || '').trim()
    const apiKey = (endpointFields.apiKey?.value || '').trim()

    if (!baseUrl && !apiKey) {
      return undefined
    }

    if (strict && (!baseUrl || !apiKey)) {
      throw new Error(`${label} 的 Base URL 和 API Key 均不能为空`)
    }

    return {
      baseUrl,
      apiKey
    }
  }

  function setSimpleField(field, value) {
    if (!field) {
      return
    }
    field.value = value ?? ''
  }

  function updateLoadingUI() {
    if (!configSection) {
      return
    }
    configSection.classList.toggle('loading', state.loading)

    // 更新工具栏状态提示
    const toolbarStatus = document.getElementById('toolbar-status')
    if (toolbarStatus) {
      toolbarStatus.classList.remove('hidden', 'success', 'warning', 'error')

      if (state.loading) {
        toolbarStatus.textContent = '正在加载配置...'
        toolbarStatus.classList.add('warning')
      } else if (state.refreshing) {
        toolbarStatus.textContent = '正在刷新余额状态...'
        toolbarStatus.classList.add('success')
      } else {
        toolbarStatus.textContent = ''
        // 默认样式，不添加额外类
      }
    }

    // 加载时禁用手动刷新和新增配置按钮
    if (refreshBtn) {
      refreshBtn.disabled = state.loading || state.refreshing
      refreshBtn.textContent = state.loading ? '加载中…' : state.refreshing ? '刷新中…' : '刷新'
    }

    if (toggleFormBtn) {
      toggleFormBtn.disabled = state.loading
    }
  }

  function resetPreviews() {
    if (claudeSettingsInput) {
      claudeSettingsInput.value = ''
    }
    if (codexAuthInput) {
      codexAuthInput.value = ''
    }
    if (codexTomlInput) {
      codexTomlInput.value = ''
    }
  }

  function updatePreviewContent() {
    if (previewLock) {
      return
    }
    previewLock = true
    const payload = readPayloadFromFields({ strict: false })

    if (claudeSettingsInput) {
      const text = mergeClaudeSettings(claudeSettingsInput.value, payload.claude)
      claudeSettingsInput.value = text
    }

    if (codexAuthInput) {
      const text = mergeCodexAuth(codexAuthInput.value, payload.codex)
      codexAuthInput.value = text
    }

    if (fields.codexConfigBase) {
      fields.codexConfigBase.value = payload.codex?.baseUrl
        ? `base_url = "${payload.codex.baseUrl}"`
        : ''
    }

    // codexTomlInput 不需要自动合并，用户直接编辑自定义配置部分
    previewLock = false
  }

  function mergeClaudeSettings(currentText, claude) {
    let data
    try {
      data = currentText ? JSON.parse(currentText) : {}
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        data = {}
      }
    } catch {
      data = {}
    }

    if (!data.env || typeof data.env !== 'object') {
      data.env = {}
    }

    if (claude) {
      data.env.ANTHROPIC_AUTH_TOKEN = claude.apiKey || ''
      data.env.ANTHROPIC_BASE_URL = claude.baseUrl || ''
    }

    return JSON.stringify(data, null, 2)
  }

  function mergeCodexAuth(currentText, codex) {
    let data
    try {
      data = currentText ? JSON.parse(currentText) : {}
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        data = {}
      }
    } catch {
      data = {}
    }

    if (codex) {
      data.OPENAI_API_KEY = codex.apiKey || ''
    }

    return JSON.stringify(data, null, 2)
  }

  function defaultCodexToml() {
    return [
      'model_provider = "default"',
      'model = "gpt-5.1-codex"',
      'model_reasoning_effort = "high"',
      'disable_response_storage = true',
      '',
      '[model_providers.default]',
      'name = "default"',
      'wire_api = "responses"',
      'requires_openai_auth = true'
    ].join('\n')
  }

  function stripBaseUrlFromToml(text) {
    if (!text || !text.trim()) {
      return ''
    }

    const lines = text.split('\n')
    const firstLine = lines[0]?.trim() || ''

    // 如果第一行是 base_url 行，移除它并返回其余部分
    if (/^base_url\s*=\s*"[^"]*"$/i.test(firstLine)) {
      return lines.slice(1).join('\n').trim()
    }

    return text
  }

  function applyClaudeSettingsFromPreview() {
    if (previewLock || !claudeSettingsInput) {
      return
    }

    let data
    try {
      data = JSON.parse(claudeSettingsInput.value)
    } catch {
      return
    }

    const env = data?.env || {}
    const baseUrl = typeof env.ANTHROPIC_BASE_URL === 'string' ? env.ANTHROPIC_BASE_URL : ''
    const apiKey = typeof env.ANTHROPIC_AUTH_TOKEN === 'string' ? env.ANTHROPIC_AUTH_TOKEN : ''

    previewLock = true
    setEndpointFields('claude', { baseUrl, apiKey })
    previewLock = false
    updatePreviewContent()
  }

  function applyCodexAuthFromPreview() {
    if (previewLock || !codexAuthInput) {
      return
    }

    let data
    try {
      data = JSON.parse(codexAuthInput.value)
    } catch {
      return
    }

    const apiKey = typeof data?.OPENAI_API_KEY === 'string' ? data.OPENAI_API_KEY : ''
    previewLock = true
    setEndpointFields('codex', {
      baseUrl: fields.codex.baseUrl?.value || '',
      apiKey
    })
    previewLock = false
    updatePreviewContent()
  }

  function applyCodexTomlFromPreview() {
    if (previewLock || !codexTomlInput) {
      return
    }

    // 提取第一行的 base_url（如果存在）
    const lines = codexTomlInput.value.split('\n')
    const firstLine = lines[0]?.trim() || ''
    const match = firstLine.match(/^base_url\s*=\s*"([^"]*)"$/i)

    if (match) {
      // 如果第一行是 base_url，提取它的值并更新输入框
      const baseUrl = match[1]
      previewLock = true
      setEndpointFields('codex', {
        baseUrl,
        apiKey: fields.codex.apiKey?.value || ''
      })

      // 移除第一行 base_url，保留其余作为自定义配置
      const remainingLines = lines.slice(1).join('\n').trim()
      codexTomlInput.value = remainingLines
      previewLock = false
      updatePreviewContent()
    }
  }

  function handleEditConfig(id) {
    vscode.postMessage({ type: 'requestConfig', payload: { id } })
    showToast('正在载入配置…')
  }

  function handleDeleteConfig(id) {
    vscode.postMessage({ type: 'deleteConfig', payload: { id } })
  }

  function handleActivateConfig(id, endpoint) {
    const providerType = endpoint === 'codex' ? 'codex' : 'claude'
    vscode.postMessage({ type: 'setActive', payload: { id, providerType } })
    showToast(`正在启用 ${providerType === 'claude' ? 'Claude' : 'Codex'} 配置…`)
  }

  function handleOpenWebsite(id) {
    vscode.postMessage({ type: 'openWebsite', payload: { id } })
  }

  function showToast(message) {
    if (!toastEl) {
      return
    }
    toastEl.textContent = message
    toastEl.classList.add('visible')
    setTimeout(() => toastEl?.classList.remove('visible'), 2000)
  }

  // 添加滚动监听，在滚动时给 toolbar 添加阴影效果
  const toolbar = document.querySelector('.toolbar')
  if (toolbar && configSection) {
    configSection.addEventListener('scroll', () => {
      const scrolled = configSection.scrollTop > 0
      toolbar.classList.toggle('scrolled', scrolled)
    })
  }

  // 初始化时设置 loading 状态并渲染
  state.loading = true
  renderConfigs()
  updateLoadingUI()

  // 然后请求数据
  vscode.postMessage({ type: 'ready' })
  // 请求模板列表
  vscode.postMessage({ type: 'getTemplates' })
})()
