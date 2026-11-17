import { Routes } from '@angular/router';


export const TODAY_URL = 'https://app.16ahead.com/today';

/** Leaves the app for Today's tab; the route never renders. */
export function forwardToToday ( tab: 'run' | 'plan' ): () => boolean {
  return () => {
    if ( typeof window !== 'undefined' ) window.location.replace( `${TODAY_URL}?tab=${tab}` );
    return false;
  };
}

export const marketingRoutes: Routes = [
  {
    path: '',
    pathMatch: 'full',
    loadComponent: () =>
      import( './pages/marketing-director-session/marketing-director-session.component' ).then(
        ( m ) => m.MarketingDirectorSessionComponent
      ),
    title: 'Marketing Assistant | 16Ahead'
  },
  {
    path: 'marketing-director',
    redirectTo: '',
    pathMatch: 'full'
  },
  {
    path: 'marketing-director/session',
    redirectTo: '',
    pathMatch: 'full'
  },
  // Status and Plan moved to Today (app.16ahead.com/today, Ty 2026-11-14).
  // The old addresses forward there, so bookmarks, help links and the
  // command palette still land on the right tab.
  {
    path: 'marketing-employee',
    pathMatch: 'full',
    canActivate: [forwardToToday( 'run' )],
    children: [],
  },
  {
    path: 'marketing-employee/plan',
    canActivate: [forwardToToday( 'plan' )],
    children: [],
  }
];
