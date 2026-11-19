/** Connectors page copy. English is complete; other languages translate the page frame and fall back to English for the rest. */

/** English dictionary, the complete key set. */
export const en = {
  panel: 'Connectors',
  title: 'Connectors',
  intro: 'Connect apps so the agent can use their tools in Chat and Work.',
  connectedCount: '{count} connected',
  search: 'Search connectors',
  noMatches: 'No connectors match your search.',
  addCustom: 'Add custom connector',
  loading: 'Loading connectors…',
  loadFailed: 'Connectors could not be loaded. Check the connection and try again.',
  'category.google': 'Google',
  'category.work': 'Work and productivity',
  'category.sales': 'Sales and marketing',
  'category.finance': 'Payments and finance',
  'category.design': 'Design and content',
  'category.developer': 'Developer',
  'category.data': 'Data and analytics',
  'category.search': 'Search and docs',
  'category.local': 'On this computer',
  'category.custom': 'Custom',
  connect: 'Connect',
  disconnect: 'Disconnect',
  remove: 'Remove',
  retry: 'Try again',
  cancel: 'Cancel',
  docs: 'Docs',
  save: 'Connect',
  'phase.connected': 'Connected',
  'phase.builtin': 'Always on',
  'phase.connecting': 'Connecting…',
  'phase.authorizing': 'Waiting for sign-in in your browser…',
  'phase.error': 'Not working',
  unavailable: 'Not available',
  tools: '{count} tools',
  account: 'Signed in as {account}',
  openSignIn: 'Open the sign-in page',
  'auth.none': 'No sign-in',
  'auth.oauth': 'Sign in with the app',
  'auth.key': 'Needs a key',
  'auth.google': 'Sign in with Google',
  'transport.stdio': 'Runs on this computer',
  getKey: 'Get one',
  'google.services': 'Google products',
  'google.reconnect': 'Reconnect with these products',
  'service.gmail': 'Gmail',
  'service.calendar': 'Calendar',
  'service.drive': 'Drive',
  'service.docs': 'Docs',
  'service.sheets': 'Sheets',
  'custom.title': 'Add custom connector',
  'custom.description': 'Connect any MCP server that speaks Streamable HTTP. Servers that need sign-in open their sign-in page.',
  'custom.name': 'Name',
  'custom.namePlaceholder': 'My server',
  'custom.url': 'Server URL',
  'custom.headerName': 'Header name (optional)',
  'custom.headerValue': 'Header value (optional)',
  'custom.headerHint': 'For servers that use an API key, such as Authorization with Bearer sk-…',
  close: 'Close',
}

/** Localized key set. */
export type ConnectorsLocaleKey = keyof typeof en


/** Chinese frame copy. */
export const zh: typeof en = { ...en,  panel: '连接器', title: '连接器', intro: '连接应用，让智能体在聊天和工作模式中使用它们的工具。', search: '搜索连接器', addCustom: '添加自定义连接器', connect: '连接', disconnect: '断开', cancel: '取消', 'phase.connected': '已连接' }
/** Japanese frame copy. */
export const ja: typeof en = { ...en,  panel: 'コネクタ', title: 'コネクタ', intro: 'アプリを接続すると、エージェントがチャットと作業でそのツールを使えます。', search: 'コネクタを検索', addCustom: 'カスタムコネクタを追加', connect: '接続', disconnect: '切断', cancel: 'キャンセル', 'phase.connected': '接続済み' }
/** Spanish frame copy. */
export const es: typeof en = { ...en,  panel: 'Conectores', title: 'Conectores', intro: 'Conecta aplicaciones para que el agente use sus herramientas en Chat y Trabajo.', search: 'Buscar conectores', addCustom: 'Añadir conector personalizado', connect: 'Conectar', disconnect: 'Desconectar', cancel: 'Cancelar', 'phase.connected': 'Conectado' }
/** French frame copy. */
export const fr: typeof en = { ...en,  panel: 'Connecteurs', title: 'Connecteurs', intro: 'Connectez des applications pour que l’agent utilise leurs outils en Chat et en Travail.', search: 'Rechercher des connecteurs', addCustom: 'Ajouter un connecteur personnalisé', connect: 'Connecter', disconnect: 'Déconnecter', cancel: 'Annuler', 'phase.connected': 'Connecté' }
/** German frame copy. */
export const de: typeof en = { ...en,  panel: 'Konnektoren', title: 'Konnektoren', intro: 'Verbinden Sie Apps, damit der Agent ihre Werkzeuge in Chat und Arbeit nutzen kann.', search: 'Konnektoren suchen', addCustom: 'Eigenen Konnektor hinzufügen', connect: 'Verbinden', disconnect: 'Trennen', cancel: 'Abbrechen', 'phase.connected': 'Verbunden' }
/** Russian frame copy. */
export const ru: typeof en = { ...en,  panel: 'Коннекторы', title: 'Коннекторы', intro: 'Подключите приложения, чтобы агент использовал их инструменты в чате и работе.', search: 'Поиск коннекторов', addCustom: 'Добавить свой коннектор', connect: 'Подключить', disconnect: 'Отключить', cancel: 'Отмена', 'phase.connected': 'Подключено' }
/** Portuguese frame copy. */
export const pt: typeof en = { ...en,  panel: 'Conectores', title: 'Conectores', intro: 'Conecte apps para que o agente use as ferramentas deles no Chat e no Trabalho.', search: 'Pesquisar conectores', addCustom: 'Adicionar conector personalizado', connect: 'Conectar', disconnect: 'Desconectar', cancel: 'Cancelar', 'phase.connected': 'Conectado' }
