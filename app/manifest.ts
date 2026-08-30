import type { MetadataRoute } from 'next';

/**
 * Makes the dashboard installable to the phone home screen.
 * Opens straight to /dashboard rather than the marketing-less root.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Personal AI Manager',
    short_name: 'Assistant',
    description: 'Tasks, reminders and progress, driven from WhatsApp.',
    start_url: '/dashboard',
    display: 'standalone',
    background_color: '#0a0a0a',
    theme_color: '#111827',
    icons: [
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
    ],
  };
}
