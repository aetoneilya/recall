<script lang="ts" module>
  // Stroke icons on a 24px grid.
  const paths = {
    review: 'M7 4h10a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM9 9h6M9 13h4',
    inbox: 'M4 13l2.5-7.5A2 2 0 0 1 8.4 4h7.2a2 2 0 0 1 1.9 1.5L20 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-5zM4 13h4.5l1.5 2.5h4l1.5-2.5H20',
    words: 'M5 5.5A1.5 1.5 0 0 1 6.5 4H18v14H6.5A1.5 1.5 0 0 0 5 19.5v-14zM5 19.5A1.5 1.5 0 0 0 6.5 21H18v-3M9 8.5h5',
    progress: 'M5 20V11M10 20V5M15 20v-7M20 20v-4',
    settings:
      'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM19.4 13.5l1.6 1.2-2 3.4-1.9-.7a7.6 7.6 0 0 1-2 1.2L14.8 20.5h-4l-.3-1.9a7.6 7.6 0 0 1-2-1.2l-1.9.7-2-3.4 1.6-1.2a7.7 7.7 0 0 1 0-2.4L4.6 9.9l2-3.4 1.9.7a7.6 7.6 0 0 1 2-1.2l.3-2h4l.3 2a7.6 7.6 0 0 1 2 1.2l1.9-.7 2 3.4-1.6 1.2a7.7 7.7 0 0 1 0 2.4z',
    undo: 'M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11',
    back: 'M15 5l-7 7 7 7',
    chevron: 'M9 5l7 7-7 7',
    plus: 'M12 5v14M5 12h14',
    minus: 'M5 12h14',
    arrow: 'M12 19V5M6 11l6-6 6 6',
    clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7.5V12l3 2',
    check: 'M5 12.5l4.5 4.5L19 7.5',
    x: 'M6 6l12 12M18 6L6 18',
    edit: 'M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4zM13.5 6.5l4 4',
    search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4',
    copy: 'M9 9h10v11H9zM5 15V4h10',
    offline: 'M3 3l18 18M8.5 16.5a5 5 0 0 1 7 0M5 12.6a10 10 0 0 1 5.2-2.6M19 12.6a10 10 0 0 0-2.5-1.7M2 8.8a15 15 0 0 1 4.4-2.7M22 8.8A15 15 0 0 0 11 5M12 20h.01',
    refresh: 'M20 11a8 8 0 0 0-14.6-4.5L4 8M4 4v4h4M4 13a8 8 0 0 0 14.6 4.5L20 16M20 20v-4h-4',
    // Telegram's paper plane.
    send: 'M21 4L3 11.2l6 2.3M21 4l-3.2 16-8.8-6.5M21 4L9 13.5v5.8l3.4-3.3',
    lock: 'M7 11V8a5 5 0 0 1 10 0v3M6.5 11h11a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 18.5v-6A1.5 1.5 0 0 1 6.5 11z',
    sparkle: 'M12 3.5l1.8 4.9 4.7 1.6-4.7 1.6L12 16.5l-1.8-4.9L5.5 10l4.7-1.6L12 3.5zM18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7.7-1.8z',
    trash: 'M4.5 7h15M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4.5h6V7',
    flame: 'M12 21a6 6 0 0 0 6-6c0-4-3.5-6-4-10-2.5 1.5-4 4-3.5 6.5-1-.5-2-1.6-2.2-3C6.6 10 6 12.4 6 15a6 6 0 0 0 6 6z',
    info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5.5M12 7.6h.01',
    warn: 'M12 4l9 16H3l9-16zM12 10v4.5M12 17.4h.01',
    pause: 'M9 6v12M15 6v12',
    play: 'M8 5.5v13l10.5-6.5L8 5.5z',
    key: 'M15 14a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM11.5 12.5L4 20M7.5 16.5l2 2M5 19l1.5 1.5',
  } as const
  export type IconName = keyof typeof paths
</script>

<script lang="ts">
  let { name, size = 24, stroke = 1.8 }: { name: IconName; size?: number; stroke?: number } = $props()
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width={stroke}
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  <path d={paths[name]} />
</svg>
