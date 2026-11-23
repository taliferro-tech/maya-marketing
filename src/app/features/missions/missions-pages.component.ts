import { isPlatformBrowser } from '@angular/common';
import { Component, inject, OnInit, PLATFORM_ID } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';

/** Where work that needs more than marketing is planned (Moves owns Missions). Exported for the spec. */
export function movesNewMissionUrl ( q?: string | null ): string {
  const request = ( q || '' ).trim();
  return `https://moves.16ahead.com/missions/new${request ? `?q=${encodeURIComponent( request )}` : ''}`;
}

/**
 * Missions live in Moves (2026-11-23): Moves plans and runs every Mission;
 * the assistants' apps hand the request over instead of creating Missions
 * themselves. Old links to marketing.16ahead.com/missions (with any ?q=)
 * land on Moves' New Mission page. The card says where it's going, so the
 * page is never blank while Moves opens.
 */
@Component( {
  selector: 'app-maya-missions-page',
  standalone: true,
  imports: [RouterLink],
  template: `
    <div class="page">
      <nav class="top"><a routerLink="/work">The Marketing Assistant’s work</a></nav>
      <section class="card" data-cy="missions-in-moves">
        <h1>Missions live in Moves</h1>
        <p>Work that needs more than marketing is planned in Moves: you say what you need, and the plan gives every step an owner (the Marketing Assistant, the General Assistant or you). Nothing starts until you press Start.</p>
        <p class="muted">Opening Moves…</p>
        <a class="btn" [href]="url" data-cy="missions-open-moves">Open Moves</a>
      </section>
    </div>
  `,
  styles: [`
    :host { display: block; min-height: 100vh; background: var(--bg); color: var(--text); font-family: var(--font); }
    .page { max-width: 760px; margin: 0 auto; padding: 28px 36px 64px; display: flex; flex-direction: column; gap: 20px; }
    .top { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 14px; font-size: 14px; font-weight: 700; }
    .top a { color: var(--text); text-decoration: none; }
    .card { background: var(--surface); border-radius: 24px; padding: 24px; display: flex; flex-direction: column; gap: 12px; align-items: flex-start; }
    h1 { margin: 0; font-size: 28px; font-weight: 700; letter-spacing: -0.03em; }
    p { margin: 0; line-height: 1.5; }
    .muted { color: var(--muted); font-size: 14px; }
    .btn { height: 44px; padding: 0 22px; border-radius: 999px; background: var(--blue); color: #fff; font-weight: 700; display: inline-flex; align-items: center; text-decoration: none; }
    @media (max-width: 640px) { .page { padding: 20px 16px 48px; } }
  `],
} )
export class MayaMissionsPageComponent implements OnInit {
  private readonly route = inject( ActivatedRoute );
  private readonly isBrowser = isPlatformBrowser( inject( PLATFORM_ID ) );
  url = movesNewMissionUrl();

  ngOnInit (): void {
    this.url = movesNewMissionUrl( this.route.snapshot.queryParamMap.get( 'q' ) );
    if ( this.isBrowser && !( window as unknown as { Cypress?: unknown } ).Cypress ) window.location.replace( this.url );
  }
}
