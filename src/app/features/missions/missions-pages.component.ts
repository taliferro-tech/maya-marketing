import { Component, Directive, inject, OnInit, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { map } from 'rxjs';

import { AuthService } from '../../services/auth.service';
import { PlanReplyComponent } from '../../shared/missions/plan-reply.component';

/**
 * Missions from Maya (design_handoff_todd_missions 1e): work that needs more
 * than marketing gets a plan with an owner on every step - Maya's, TODD's and
 * yours. A started Mission lives in Moves. Shared taliferro-ui/missions screens.
 */
@Directive()
abstract class SignedInPage implements OnInit {
  protected readonly auth = inject( AuthService );
  readonly signedIn = signal<boolean | null>( null );
  readonly viewerId = signal( '' );

  ngOnInit (): void {
    this.auth.isLoggedIn().subscribe( ( yes ) => {
      this.signedIn.set( yes );
      if ( yes ) this.viewerId.set( this.auth.getCurrentUserIdSync() || '' );
    } );
  }
}

const STYLES = `
  :host { display: block; min-height: 100vh; background: var(--bg); color: var(--text); font-family: var(--font); }
  .page { max-width: 1100px; margin: 0 auto; padding: 28px 36px 64px; display: flex; flex-direction: column; gap: 20px; }
  .wide { max-width: 1280px; }
  .top { display: flex; align-items: center; gap: 14px; font-size: 14px; font-weight: 700; }
  .top a { color: var(--text); text-decoration: none; }
  .spacer { flex: 1; }
  h1 { margin: 0; font-size: 34px; font-weight: 700; letter-spacing: -0.04em; }
  .signin { background: var(--surface); border-radius: 24px; padding: 24px; display: flex; flex-direction: column; gap: 10px; align-items: flex-start; }
  .signin p { margin: 0; line-height: 1.5; }
  .ask { display: flex; gap: 10px; }
  .ask input { flex: 1; min-width: 0; height: 44px; padding: 0 16px; border: 1px solid var(--border, rgba(127,127,127,.3)); border-radius: 999px; background: var(--surface); color: var(--text); font: inherit; }
  .btn { border: 0; cursor: pointer; font: inherit; font-weight: 700; height: 44px; padding: 0 22px; border-radius: 999px; background: var(--blue); color: #fff; font-weight: 700; display: inline-flex; align-items: center; text-decoration: none; }
  @media (max-width: 640px) { .page { padding: 20px 16px 48px; } }
`;

// Signed out: browse mode (network.16ahead.com is the model) - the page still
// shows, with the ask box; asking sends you to sign in and back with the question.
const BROWSE = `
  <div class="signin" role="note" data-cy="missions-signin">
    <b>You’re in browse mode</b>
    <p>This is where you hand the Marketing Assistant work that needs more than marketing. It writes a plan with an owner on every step (its own, the General Assistant’s and yours) and the Mission runs in Moves once you start it.</p>
    <p>Sign in to plan one. Your question comes with you.</p>
    <button type="button" class="btn" (click)="signIn()" data-cy="missions-sign-in">Sign in</button>
  </div>
  <form class="ask" (submit)="askSignedOut($event)" data-cy="missions-browse-ask">
    <input [value]="draft()" (input)="draft.set($any($event.target).value)" placeholder="What should the Marketing Assistant work on?" aria-label="What do you need?">
    <button type="submit" class="btn">Ask</button>
  </form>`;

@Component( {
  selector: 'app-maya-missions-page',
  standalone: true,
  imports: [PlanReplyComponent, RouterLink],
  template: `
    <div class="page">
      <nav class="top"><a routerLink="/work">The Marketing Assistant’s work</a><span class="spacer"></span><a href="https://assistant.16ahead.com/playbooks" data-cy="to-playbooks">Playbooks</a></nav>
      <h1>Plan it with the Marketing Assistant</h1>
      @if (signedIn() === false) { ${BROWSE} }
      @if (signedIn()) {
        <tm-plan-reply [request]="q()" origin="maya" agent="maya" [viewerId]="viewerId()" detailBase="https://moves.16ahead.com/missions/" />
      }
    </div>
  `,
  styles: [STYLES],
} )
export class MayaMissionsPageComponent extends SignedInPage {
  private readonly route = inject( ActivatedRoute );
  private readonly router = inject( Router );
  readonly q = toSignal( this.route.queryParamMap.pipe( map( ( p ) => p.get( 'q' ) || '' ) ), { initialValue: '' } );
  /** The signed-out ask box. */
  readonly draft = signal( this.route.snapshot.queryParamMap.get( 'q' ) || '' );

  /** Sign in through the get-started wizard and come back to this page, question included. */
  signIn ( question = '' ): void {
    const returnUrl = question ? `/missions?q=${encodeURIComponent( question )}` : this.router.url || '/missions';
    void this.router.navigate( ['/get-started'], { queryParams: { returnUrl } } );
  }

  askSignedOut ( event: Event ): void {
    event.preventDefault();
    this.signIn( this.draft().trim() );
  }
}

