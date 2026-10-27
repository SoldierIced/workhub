import type { sidebarEn } from './sidebar.en'

/** Spanish copy of the sidebar's profile colours, folder browser and sub-agent rows. */
export const sidebarEs: Record<keyof typeof sidebarEn, string> = {
  'sidebar.profileBar': 'Perfil {name}',
  'sidebar.profileColor': 'Color',
  'sidebar.profileColorAuto': 'Automático',
  'sidebar.profileColorOption': 'Color {n}',
  'sidebar.profileColorHint': 'Marca las sesiones de este perfil en la barra lateral, en el borde izquierdo de sus filas.',
  'sidebar.filterFolders': 'Filtrar carpetas',
  'sidebar.clearFilter': 'Borrar el filtro',
  'sidebar.results': 'Resultados',
  'sidebar.noFolderMatch': 'Ninguna carpeta coincide.',
  'sidebar.favorites': 'Favoritas',
  'sidebar.recent': 'Recientes',
  'sidebar.allFolders': 'Todas las carpetas',
  'sidebar.addFavorite': 'Agregar {folder} a Favoritas',
  'sidebar.removeFavorite': 'Quitar {folder} de Favoritas',
  'sidebar.openInFolder.one': '{count} sesión abierta aquí',
  'sidebar.openInFolder.other': '{count} sesiones abiertas aquí',
  'sidebar.subagents.show.one': 'Mostrar {count} subagente',
  'sidebar.subagents.show.other': 'Mostrar {count} subagentes',
  'sidebar.subagents.hide.one': 'Ocultar {count} subagente',
  'sidebar.subagents.hide.other': 'Ocultar {count} subagentes',
  'sidebar.subagents.list.one': '{count} subagente de {name}',
  'sidebar.subagents.list.other': '{count} subagentes de {name}',
  'sidebar.account': 'Cuenta {name}',
  'sidebar.clickToReopen': 'Clic para reabrir',
  'sidebar.resize': 'Cambiar el ancho de la barra lateral',
  'pane.resizeHint': 'Arrastra para cambiar el ancho. Doble clic para restablecerlo.'
}
