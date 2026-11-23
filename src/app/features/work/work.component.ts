import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeHtml, Title } from '@angular/platform-browser';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { Subscription } from 'rxjs';
import { MayaAuthService } from '../../services/maya-auth.service';
import { EmailFillIn, EmailSendTarget, MayaJob, MayaJobStep, MayaJobsService, MayaPlanFit, PushbackLevel, CHAT_BRIEF_MARKER, jobPath } from '../../services/maya-jobs.service';

/**
 * Opens an email Maya designed in Email Creator to revise it there. Email
 * Creator loads it from Docs, with its images (web-products/email-creator,
 * ?mayaEmail=, backend GET /email-creator/maya-email/:documentId).
 */
export function emailCreatorEditUrl ( documentId: string ): string {
  return `https://emails.16ahead.com/?mayaEmail=${encodeURIComponent( documentId )}`;
}

/**
 * Who the job's email was written for ("Agencies/consultants"), from the
 * Marketing Assistant's brief. Catalyst preselects the contacts who match,
 * or says the list doesn't (Ty, 2026-10-31).
 */
export function jobAudience ( job: Pick<MayaJob, 'brief'> | null | undefined ): string {
  return String( job?.brief?.audience || '' ).trim().slice( 0, 300 );
}

/** One thing waiting on the user, from any job. */
interface ApprovalItem {
  job: MayaJob;
  step: MayaJobStep;
  /** The drafted post this approval would schedule (from the step it depends on). */
  preview: Record<string, any> | null;
}

/** A finished email from a job, ready to open in Docs. */
interface ContactListResult {
  documentId: string;
  title: string;
  count: number;
  requested: number;
  who: string;
  url: string;
  sample: string[];
}

interface EmailResult {
  documentId: string;
  subject: string;
  preheader: string;
  fillIns: string[];
  /** Who it was written for; goes to Catalyst with the email. */
  audience: string;
}

/** Sending a finished email, the same three choices Email Creator offers. */
interface SendPanel {
  documentId: string;
  target: EmailSendTarget;
  /** null while checking; false when the workspace has no Outreach subscription. */
  canSend: boolean | null;
  fillIns: EmailFillIn[];
  values: Record<string, string>;
  working: boolean;
  error: string;
  /** Set once the handoff is ready; the user opens it in a new tab. */
  openUrl: string;
}

const ACTIVE_STATUSES = new Set( ['queued', 'running'] );
const CLOSED_STATUSES = new Set( ['done', 'failed', 'cancelled'] );
const NEEDS_YOU_STATUSES = new Set( ['awaiting_user', 'awaiting_decision', 'awaiting_approval', 'stopped'] );
/** A closed job stays under "Now" this long, so a finished email is still at hand to send. */
const RECENT_MS = 24 * 60 * 60 * 1000;
const FAST_POLL_MS = 5000;
const SLOW_POLL_MS = 30000;

/** Which part of the work page a route shows. */
export type WorkView = 'ask' | 'jobs' | 'job';

/** The browse-mode note for each view: what the page does, for someone not signed in. */
const BROWSE_COPY: Record<WorkView, string> = {
  ask: 'This is where you give the Marketing Assistant a job: posts, a social calendar, an email. It plans the work, does it, and asks you before anything is posted.',
  jobs: 'This is the list of every job you’ve given the Marketing Assistant: what it’s working on now, what’s waiting on you, and what it finished.',
  job: 'This is one job on its own page: the plan, the drafts waiting for your approval, and what the Marketing Assistant made.',
};

/** A failed load in plain words: no answer in time reads as that, not "Timeout has occurred". */
export function loadErrorText ( error: any, fallback: string ): string {
  if ( error?.name === 'TimeoutError' ) return `${fallback} It took too long to answer; trying again shortly.`;
  return error?.error?.message || fallback;
}

/** Everything waiting for a yes or no across these jobs, oldest job first. */
function approvalsFor ( jobs: MayaJob[] ): ApprovalItem[] {
  const items: ApprovalItem[] = [];
  for ( const job of [...jobs].reverse() ) {
    if ( job.status === 'cancelled' || job.status === 'failed' ) continue;
    const steps = job.steps || [];
    const byId = new Map( steps.map( ( step ) => [step.id, step] ) );
    for ( const step of steps ) {
      const dependsOn = step.dependsOn || [];
      const decided = !!job.approvals?.[step.id];
      const ready = dependsOn.every( ( id ) => byId.get( id )?.status === 'done' );
      if ( step.access !== 'approval' || step.status !== 'pending' || step.approvedBy || decided || !ready ) continue;
      const source = dependsOn.map( ( id ) => byId.get( id ) ).find( ( dep ) => dep?.tool === 'social.draftPost' || dep?.tool === 'ads.draftCampaign' );
      items.push( { job, step, preview: source?.output || null } );
    }
  }
  return items;
}

/** Contact lists Maya built from Lead Vault in a job. */
function contactListsFor ( job: MayaJob | null ): ContactListResult[] {
  return ( job?.steps || [] )
    .filter( ( step ) => step.tool === 'leads.findList' && step.status === 'done' && step.output?.['documentId'] )
    .map( ( step ) => ( {
      documentId: String( step.output!['documentId'] ),
      title: String( step.output!['title'] || 'Contact list' ),
      count: Number( step.output!['count'] ) || 0,
      requested: Number( step.output!['requested'] ) || 0,
      who: String( step.output!['who'] || '' ),
      url: String( step.output!['src'] || '' ),
      sample: ( Array.isArray( step.output!['sample'] ) ? step.output!['sample'] : [] )
        .map( ( row: any ) => [row?.name, row?.title && row?.company ? `${row.title}, ${row.company}` : row?.company].filter( Boolean ).join( ' - ' ) ),
    } ) );
}

/**
 * Maya's work, in three routes (Ty, 2026-10-30): /work is Ask (what to do,
 * and how hard she pushes back), /work/jobs lists every job with the ones
 * waiting on you first, and /work/jobs/:id is one job on its own, with its
 * concerns, questions, approvals and finished emails. The old ?job= links
 * redirect to the job's page. Backed by /api/maya/jobs
 * (MAYA-ORCHESTRATION-DESIGN.md, gaps 3 and 6).
 */
@Component( {
  selector: 'app-work',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule],
  templateUrl: './work.component.html',
  styleUrl: './work.component.css',
} )
export class WorkComponent implements OnInit, OnDestroy {
  readonly pushbackOptions: Array<{ id: PushbackLevel; label: string; detail: string; }> = [
    { id: 'firm', label: 'Firm', detail: 'Stops and makes its case when a request works against the plan.' },
    { id: 'standard', label: 'Standard', detail: 'Stops and lists the consequences, without arguing.' },
    { id: 'light', label: 'Light', detail: 'Goes ahead and tells you the consequences up front.' },
  ];

  readonly suggestions = [
    'Build a LinkedIn calendar for the next two weeks',
    'Plan three posts about our newest product',
    'Fill next week with posts on every account I have connected',
    'Write an email introducing us to new prospects',
  ];

  /** null until Firebase reports auth state; false shows the page in browse mode. */
  isSignedIn: boolean | null = null;
  /** What this view is for, shown in the browse-mode note when signed out. */
  browseCopy = '';
  // jobs, openedJob, jobId and tab are accessors so every write refreshes
  // the shown fields below (recompute), wherever it happens.
  private jobsValue: MayaJob[] = [];
  get jobs (): MayaJob[] { return this.jobsValue; }
  set jobs ( value: MayaJob[] ) { this.jobsValue = value; this.recompute(); }
  /** The job /work/jobs/:id shows: from the list, else loaded on its own. */
  job: MayaJob | null = null;
  /** Jobs waiting on the person: a concern, a question, drafts to approve, or a stop. */
  needsYouJobs: MayaJob[] = [];
  /** Everything waiting for a yes or no, oldest job first. */
  approvals: ApprovalItem[] = [];
  jobApprovals: ApprovalItem[] = [];
  jobEmails: EmailResult[] = [];
  /** Contact lists Maya built from Lead Vault in this job. */
  jobContactLists: ContactListResult[] = [];
  currentJobs: MayaJob[] = [];
  pastJobs: MayaJob[] = [];
  shownJobs: MayaJob[] = [];
  loaded = false;
  errorMessage = '';
  /** Set while loading the jobs (or this job) is failing; the next poll tries again. */
  loadError = '';
  needsPurchase = false;
  request = '';
  isStarting = false;
  answers: Record<string, string> = {};
  busy: Record<string, boolean> = {};
  pushbackLevel: PushbackLevel | null = null;
  socialAutopilot = false;
  previews: Record<string, SafeHtml> = {};
  previewOpen: Record<string, boolean> = {};
  sendPanel: SendPanel | null = null;
  view: WorkView = 'ask';
  private jobIdValue = '';
  /** The job /work/jobs/:id shows. */
  get jobId (): string { return this.jobIdValue; }
  set jobId ( value: string ) { this.jobIdValue = value; this.recompute(); }
  /** Set when that job isn't in the list and couldn't be loaded on its own. */
  jobMissing = false;
  /** A job opened by id that's older than the list goes back (kept so its page still works). */
  private openedJobValue: MayaJob | null = null;
  private get openedJob (): MayaJob | null { return this.openedJobValue; }
  private set openedJob ( value: MayaJob | null ) { this.openedJobValue = value; this.recompute(); }
  /** Decision cards whose full request is showing. */
  requestOpen: Record<string, boolean> = {};
  /** Jobs list tab: what's going on now, or finished work. */
  private tabValue: 'now' | 'past' = 'now';
  get tab (): 'now' | 'past' { return this.tabValue; }
  set tab ( value: 'now' | 'past' ) { this.tabValue = value; this.recompute(); }
  readonly targetNames: Record<EmailSendTarget, string> = { catalyst: 'Catalyst', composer: 'Email Composer', drips: 'Drips' };
  readonly editUrl = emailCreatorEditUrl;
  private emailHtml: Record<string, string> = {};

  private authSubscription?: Subscription;
  private paramSubscription?: Subscription;
  private pollTimer?: ReturnType<typeof setTimeout>;
  private destroyed = false;

  constructor (
    private readonly api: MayaJobsService,
    private readonly authService: MayaAuthService,
    private readonly title: Title,
    private readonly sanitizer: DomSanitizer,
    private readonly router: Router,
    private readonly route: ActivatedRoute,
  ) { }

  ngOnInit (): void {
    this.title.setTitle( "The Marketing Assistant's work — Marketing Assistant | 16Ahead" );
    // Links from before jobs had their own page (/work?job=<id>) open the job's page.
    const linkedJob = this.route.snapshot.queryParamMap.get( 'job' );
    if ( linkedJob ) {
      void this.router.navigateByUrl( jobPath( linkedJob ), { replaceUrl: true } );
      return;
    }
    this.view = ( this.route.snapshot.data['view'] as WorkView ) || 'ask';
    this.browseCopy = BROWSE_COPY[this.view];
    this.paramSubscription = this.route.paramMap.subscribe( ( params ) => {
      this.jobId = params.get( 'id' ) || '';
      this.jobMissing = false;
      this.openedJob = null;
      this.sendPanel = null;
      if ( this.jobId && this.loaded && this.isSignedIn ) void this.loadOpenedJob();
    } );
    this.authSubscription = this.authService.isLoggedIn().subscribe( ( signedIn ) => {
      const wasSignedIn = this.isSignedIn;
      this.isSignedIn = signedIn;
      if ( signedIn && !wasSignedIn ) {
        this.loaded = false;
        // A job's page asks for that one job straight away, alongside the
        // list, so it shows without waiting on all 25 jobs.
        if ( this.view === 'job' && this.jobId ) void this.loadOpenedJob();
        void this.refresh();
        void this.loadSettings();
      } else if ( !signedIn ) {
        // Browse mode: the page shows empty instead of waiting on data it can't load.
        if ( this.pollTimer ) clearTimeout( this.pollTimer );
        this.jobs = [];
        this.openedJob = null;
        this.loaded = true;
      }
    } );
  }

  ngOnDestroy (): void {
    this.destroyed = true;
    this.authSubscription?.unsubscribe();
    this.paramSubscription?.unsubscribe();
    if ( this.pollTimer ) clearTimeout( this.pollTimer );
  }

  /** Sign in goes through the get-started wizard, then comes back here. */
  signIn (): void {
    void this.router.navigate( ['/get-started'], { queryParams: { returnUrl: this.router.url || '/work' } } );
  }

  // What the template shows is worked out here once per change to the jobs,
  // the opened job, the job id or the tab, not on every change-detection
  // pass (template rule: no getters doing real work in bindings).
  private recompute (): void {
    const jobs = this.jobsValue;
    const opened = this.openedJobValue;
    const jobId = this.jobIdValue;
    this.job = jobId ? jobs.find( ( job ) => job.id === jobId ) || opened : null;
    this.approvals = approvalsFor( opened && !jobs.some( ( job ) => job.id === opened.id ) ? [...jobs, opened] : jobs );
    const waiting = new Set( this.approvals.map( ( item ) => item.job.id ) );
    this.needsYouJobs = jobs.filter( ( job ) => NEEDS_YOU_STATUSES.has( job.status ) || waiting.has( job.id ) );
    this.jobApprovals = this.approvals.filter( ( entry ) => entry.job.id === jobId );
    this.jobEmails = this.job ? this.emails( this.job ) : [];
    this.jobContactLists = contactListsFor( this.job );
    this.currentJobs = jobs.filter( ( job ) => this.isCurrent( job ) );
    this.pastJobs = jobs.filter( ( job ) => !this.isCurrent( job ) );
    this.shownJobs = this.tabValue === 'now' ? this.currentJobs : this.pastJobs;
  }

  async decidePlan ( job: MayaJob, choice: 'recommended' | 'as_asked' | 'cancel' ): Promise<void> {
    if ( this.busy[job.id] ) return;
    this.busy[job.id] = true;
    this.errorMessage = '';
    try {
      this.replace( await this.api.decidePlan( job.id, choice ) );
      this.schedulePoll( FAST_POLL_MS );
    } catch ( error: any ) {
      this.errorMessage = error?.error?.message || error?.message || 'That didn’t go through. Please try again.';
    } finally {
      this.busy[job.id] = false;
    }
  }

  async setPushback ( level: PushbackLevel ): Promise<void> {
    if ( level === this.pushbackLevel ) return;
    const previous = this.pushbackLevel;
    this.pushbackLevel = level;
    try {
      await this.api.saveSettings( level );
    } catch ( error: any ) {
      this.pushbackLevel = previous;
      this.errorMessage = error?.error?.message || error?.message || 'We couldn’t save that setting.';
    }
  }

  verdictLabel ( planFit: MayaPlanFit | null | undefined ): string {
    switch ( planFit?.verdict ) {
      case 'fits': return 'Fits your plan';
      case 'adjacent': return 'Close to your plan';
      case 'conflicts': return 'Works against your plan';
      case 'no_plan': return 'No marketing plan yet';
      default: return '';
    }
  }

  /** An idea fills the box to edit or send, so one click doesn't start a job. */
  useIdea ( idea: string, input: HTMLTextAreaElement ): void {
    this.request = idea;
    input.focus();
  }

  /** In progress, waiting on the person, or closed within the last day. */
  isCurrent ( job: MayaJob ): boolean {
    if ( !CLOSED_STATUSES.has( job.status ) ) return true;
    return Date.now() - new Date( job.updatedAt ).getTime() < RECENT_MS;
  }


  /** What the person asked, without the brief the chat appended. */
  jobTitle ( job: MayaJob ): string {
    return job.request.replace( CHAT_BRIEF_MARKER, '' ).trim() || job.request;
  }

  /** Whether the request carries more than its title shows. */
  hasMoreRequest ( job: MayaJob ): boolean {
    return this.jobTitle( job ) !== job.request.trim();
  }

  async start ( text?: string ): Promise<void> {
    const request = ( text ?? this.request ).trim();
    if ( !request || this.isStarting ) return;
    if ( !this.isSignedIn ) {
      this.signIn();
      return;
    }
    this.isStarting = true;
    this.errorMessage = '';
    this.needsPurchase = false;
    try {
      const job = await this.api.start( request );
      this.jobs = [job, ...this.jobs];
      this.request = '';
      // The job's own page shows it planning, and any question or concern it has.
      void this.router.navigateByUrl( jobPath( job.id ) );
      this.schedulePoll( FAST_POLL_MS );
    } catch ( error: any ) {
      this.needsPurchase = error?.error?.error === 'APP_PURCHASE_REQUIRED';
      this.errorMessage = error?.error?.message || error?.message || 'The Marketing Assistant couldn’t start that.';
    } finally {
      this.isStarting = false;
    }
  }

  async decide ( item: ApprovalItem, decision: 'approve' | 'reject' ): Promise<void> {
    const key = `${item.job.id}/${item.step.id}`;
    if ( this.busy[key] ) return;
    this.busy[key] = true;
    this.errorMessage = '';
    try {
      await this.api.decide( item.job.id, item.step.id, decision );
      item.job.approvals = {
        ...( item.job.approvals || {} ),
        [item.step.id]: { decision: decision === 'approve' ? 'approved' : 'rejected', by: 'you', at: new Date().toISOString() },
      };
      this.recompute();
      this.schedulePoll( FAST_POLL_MS );
    } catch ( error: any ) {
      this.errorMessage = error?.error?.message || error?.message || 'That didn’t go through. Please try again.';
    } finally {
      this.busy[key] = false;
    }
  }

  async approveAll ( job: MayaJob ): Promise<void> {
    for ( const item of this.approvals.filter( ( entry ) => entry.job.id === job.id ) ) {
      await this.decide( item, 'approve' );
    }
  }

  /** Emails Maya designed in this job, with anything still to fill in before sending. */
  emails ( job: MayaJob ): EmailResult[] {
    return ( job.steps || [] )
      .filter( ( step ) => step.tool === 'email.create' && step.status === 'done' && step.output?.['documentId'] )
      .map( ( step ) => ( {
        documentId: String( step.output!['documentId'] ),
        subject: String( step.output!['subject'] || 'Email from the Marketing Assistant' ),
        preheader: String( step.output!['preheader'] || '' ),
        fillIns: Array.isArray( step.output!['fillIns'] ) ? step.output!['fillIns'] : [],
        audience: jobAudience( job ),
      } ) );
  }

  /** Loads (once) and shows or hides an email's preview. */
  async togglePreview ( email: EmailResult ): Promise<void> {
    if ( this.previews[email.documentId] !== undefined ) {
      this.previewOpen[email.documentId] = !this.previewOpen[email.documentId];
      return;
    }
    this.busy[email.documentId] = true;
    try {
      const loaded = await this.api.email( email.documentId );
      this.emailHtml[email.documentId] = loaded.html;
      // The frame is sandboxed with no permissions (no scripts, forms or
      // navigation), so rendering Maya's generated HTML in it is safe.
      this.previews[email.documentId] = this.sanitizer.bypassSecurityTrustHtml( loaded.html );
      this.previewOpen[email.documentId] = true;
    } catch ( error: any ) {
      this.errorMessage = error?.error?.message || error?.message || 'We couldn’t load that email.';
    } finally {
      this.busy[email.documentId] = false;
    }
  }

  /** Saves a contact list from the page, as Download HTML does for emails. */
  async downloadCsv ( list: ContactListResult ): Promise<void> {
    this.busy[list.documentId] = true;
    try {
      const loaded = await this.api.contactList( list.documentId );
      const url = URL.createObjectURL( new Blob( [loaded.csv], { type: 'text/csv;charset=utf-8' } ) );
      const link = document.createElement( 'a' );
      link.href = url;
      link.download = loaded.fileName || 'contact-list.csv';
      link.click();
      setTimeout( () => URL.revokeObjectURL( url ), 1000 );
    } catch ( error: any ) {
      this.errorMessage = error?.error?.message || error?.message || 'We couldn’t download that list.';
    } finally {
      this.busy[list.documentId] = false;
    }
  }

  async downloadHtml ( email: EmailResult ): Promise<void> {
    const html = await this.loadHtml( email );
    const url = URL.createObjectURL( new Blob( [html], { type: 'text/html' } ) );
    const link = document.createElement( 'a' );
    link.href = url;
    link.download = `${email.subject.replace( /[^a-z0-9_ -]/gi, '' ).trim().replace( /\s+/g, '-' ) || 'email'}.html`;
    link.click();
    setTimeout( () => URL.revokeObjectURL( url ), 1000 );
  }

  /**
   * Starts sending: checks the Outreach subscription and what's left to fill
   * in. With nothing to fill in, prepares the handoff straight away.
   */
  async openSend ( email: EmailResult, target: EmailSendTarget ): Promise<void> {
    const panel: SendPanel = { documentId: email.documentId, target, canSend: null, fillIns: [], values: {}, working: true, error: '', openUrl: '' };
    this.sendPanel = panel;
    try {
      const html = await this.loadHtml( email );
      const check = await this.api.sendCheck( email.subject, html );
      Object.assign( panel, { canSend: check.canSendWithOutreach, fillIns: check.fillIns[target] || [], working: false } );
      if ( panel.canSend && panel.fillIns.length === 0 ) await this.prepareSend( email );
    } catch ( error: any ) {
      Object.assign( panel, { working: false, error: error?.error?.message || error?.message || 'Something went wrong.' } );
    }
  }

  fillsComplete ( panel: SendPanel ): boolean {
    return panel.fillIns.every( ( item ) => ( panel.values[item.token] || '' ).trim().length > 0 );
  }

  async prepareSend ( email: EmailResult ): Promise<void> {
    const panel = this.sendPanel;
    if ( !panel || panel.documentId !== email.documentId || !this.fillsComplete( panel ) ) return;
    Object.assign( panel, { working: true, error: '' } );
    try {
      panel.openUrl = await this.api.handOffEmail( {
        target: panel.target, subject: email.subject, preheader: email.preheader, html: await this.loadHtml( email ), fills: panel.values,
        ...( panel.target === 'catalyst' && email.audience ? { audience: email.audience } : {} ),
      } );
    } catch ( error: any ) {
      panel.error = error?.error?.message || error?.message || 'Something went wrong.';
    } finally {
      panel.working = false;
    }
  }

  closeSend (): void {
    this.sendPanel = null;
  }

  async sendAnswer ( job: MayaJob ): Promise<void> {
    const answer = ( this.answers[job.id] || '' ).trim();
    if ( !answer || this.busy[job.id] ) return;
    this.busy[job.id] = true;
    try {
      const updated = await this.api.answer( job.id, answer );
      this.replace( updated );
      this.answers[job.id] = '';
      this.schedulePoll( FAST_POLL_MS );
    } catch ( error: any ) {
      this.errorMessage = error?.error?.message || error?.message || 'The Marketing Assistant didn’t get that answer. Please try again.';
    } finally {
      this.busy[job.id] = false;
    }
  }

  async cancel ( job: MayaJob ): Promise<void> {
    if ( this.busy[job.id] ) return;
    this.busy[job.id] = true;
    try {
      await this.api.cancel( job.id );
      await this.refresh();
    } finally {
      this.busy[job.id] = false;
    }
  }

  async resume ( job: MayaJob ): Promise<void> {
    if ( this.busy[job.id] ) return;
    this.busy[job.id] = true;
    try {
      await this.api.resume( job.id );
      this.schedulePoll( FAST_POLL_MS );
    } finally {
      this.busy[job.id] = false;
    }
  }

  isActive ( job: MayaJob ): boolean {
    return ACTIVE_STATUSES.has( job.status );
  }

  canCancel ( job: MayaJob ): boolean {
    return !['done', 'failed', 'cancelled'].includes( job.status );
  }

  statusLabel ( job: MayaJob ): string {
    switch ( job.status ) {
      case 'queued':
      case 'running': return job.steps.length ? 'Working on it' : 'Planning';
      case 'awaiting_user': return 'Needs your answer';
      case 'awaiting_decision': return 'The Marketing Assistant has concerns';
      case 'awaiting_approval': return 'Waiting for your approval';
      case 'waiting': return job.resumeAt ? `Continues ${this.shortDateTime( job.resumeAt )}` : 'Paused';
      case 'done': return 'Done';
      case 'failed': return 'Couldn’t finish';
      case 'stopped': return 'Stopped';
      case 'cancelled': return 'Cancelled';
      default: return job.status;
    }
  }

  statusTone ( job: MayaJob ): 'active' | 'attention' | 'done' | 'muted' | 'error' {
    if ( this.isActive( job ) ) return 'active';
    if ( ['awaiting_user', 'awaiting_decision', 'awaiting_approval', 'stopped'].includes( job.status ) ) return 'attention';
    if ( job.status === 'done' ) return 'done';
    if ( job.status === 'failed' ) return 'error';
    return 'muted';
  }

  progress ( job: MayaJob ): { done: number; total: number; } {
    const total = job.steps.length;
    const done = job.steps.filter( ( step ) => step.status !== 'pending' ).length;
    return { done, total };
  }

  stepLabel ( step: MayaJobStep ): string {
    const input = step.input || {};
    switch ( step.tool ) {
      case 'image.obtain': return step.output?.['reused'] ? 'Reused a library image' : `Image: ${String( input['title'] || input['topic'] || 'for a post' )}`;
      case 'social.draftPost': {
        const platform = this.platformLabel( String( step.output?.['platform'] || input['platform'] || 'social' ) );
        const day = step.output?.['plannedForDate'] || input['plannedForDate'];
        return `${platform} post${day ? ` for ${this.shortDate( String( day ) )}` : ''}`;
      }
      case 'social.approvePost': return step.approvedBy === 'autopilot' ? 'Approved by autopilot' : 'Your approval to post';
      case 'email.create': return `Email: ${String( step.output?.['subject'] || 'design' )}`;
      case 'leads.findList': return step.output?.['count'] ? `Contact list: ${step.output['count']} people` : 'Contact list from Lead Vault';
      case 'ads.draftCampaign': return `Facebook ad, paused: ${String( step.output?.['headline'] || input['headline'] || input['productName'] || 'draft' )}`;
      case 'ads.launchCampaign': return 'Your approval to turn the ad on';
      default: return step.tool;
    }
  }

  stepState ( step: MayaJobStep ): string {
    if ( step.status === 'done' ) return 'Done';
    if ( step.status === 'failed' ) return step.error?.message || 'Failed';
    if ( step.status === 'skipped' ) return step.skipReason === 'rejected' ? 'You said no' : 'Skipped';
    if ( step.notBefore ) return `Waiting until ${this.shortDateTime( step.notBefore )}`;
    return 'To do';
  }

  /** "$10.00 a day for 7 days, about $70 at most" for an ad waiting on approval. */
  adBudget ( preview: Record<string, any> | null ): string {
    const cents = Number( preview?.['dailyBudgetCents'] || 0 );
    if ( !cents ) return '';
    return `$${ ( cents / 100 ).toFixed( 2 ) } a day for 7 days, about $${ Math.round( ( cents * 7 ) / 100 ) } at most`;
  }

  platformLabel ( platform: string ): string {
    const names: Record<string, string> = {
      linkedin: 'LinkedIn', threads: 'Threads', bluesky: 'Bluesky', reddit: 'Reddit', youtube: 'YouTube',
      google_business_profile: 'Google Business', instagram: 'Instagram', facebook: 'Facebook',
    };
    return names[platform] || platform;
  }

  shortDate ( dateKey: string ): string {
    const date = new Date( `${dateKey}T12:00:00` );
    return Number.isNaN( date.getTime() ) ? dateKey : date.toLocaleDateString( undefined, { weekday: 'short', month: 'short', day: 'numeric' } );
  }

  shortDateTime ( iso: string ): string {
    const date = new Date( iso );
    return Number.isNaN( date.getTime() ) ? iso : date.toLocaleString( undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' } );
  }

  trackById ( _index: number, item: { id: string } ): string {
    return item.id;
  }

  trackApproval ( _index: number, item: ApprovalItem ): string {
    return `${item.job.id}/${item.step.id}`;
  }

  private async loadHtml ( email: EmailResult ): Promise<string> {
    if ( this.emailHtml[email.documentId] === undefined ) {
      this.emailHtml[email.documentId] = ( await this.api.email( email.documentId ) ).html;
    }
    return this.emailHtml[email.documentId];
  }

  private async loadSettings (): Promise<void> {
    try {
      const settings = await this.api.settings();
      this.pushbackLevel = settings.pushbackLevel;
      this.socialAutopilot = settings.socialAutoApprove;
    } catch {
      this.pushbackLevel = 'firm';
    }
  }

  private replace ( job: MayaJob ): void {
    this.jobs = this.jobs.map( ( existing ) => existing.id === job.id ? job : existing );
    if ( this.openedJob?.id === job.id ) this.openedJob = job;
  }

  /** A job the list doesn't include (older than it goes back), loaded on its own. */
  private async loadOpenedJob (): Promise<void> {
    const jobId = this.jobId;
    if ( !jobId || this.jobs.some( ( job ) => job.id === jobId ) ) return;
    try {
      const job = await this.api.get( jobId );
      if ( this.jobId === jobId ) this.openedJob = job;
    } catch ( error: any ) {
      if ( this.jobId !== jobId || this.job ) return;
      // Not found (or another workspace's) says so; anything else (no
      // answer, a server error) is an error to retry, not a missing job.
      if ( error?.status === 404 || error?.status === 403 ) this.jobMissing = true;
      else this.loadError = loadErrorText( error, 'We couldn’t load this job.' );
    }
  }

  private async refresh (): Promise<void> {
    try {
      this.jobs = await this.api.list();
      this.loadError = '';
      if ( this.jobId && !this.jobs.some( ( job ) => job.id === this.jobId ) ) {
        // Refetched each pass so a job opened by id stays current too.
        await this.loadOpenedJob();
      }
      this.loaded = true;
    } catch ( error: any ) {
      this.loadError = loadErrorText( error, 'We couldn’t load the Marketing Assistant’s work.' );
    }
    const active = this.jobs.some( ( job ) => this.isActive( job ) ) || ( !!this.openedJob && this.isActive( this.openedJob ) );
    this.schedulePoll( active ? FAST_POLL_MS : SLOW_POLL_MS );
  }

  /**
   * emails() builds new objects on every pass; keyed by document, the email
   * blocks (and their Catalyst / Composer / Drips buttons) aren't rebuilt mid-click.
   */
  trackEmail ( _index: number, email: EmailResult ): string {
    return email.documentId;
  }

  // Without this, every change detection rebuilds the card (the getter makes
  // new objects), the button is replaced between mousedown and mouseup, and
  // the click never fires.
  trackList ( _index: number, list: ContactListResult ): string {
    return list.documentId;
  }

  /** Polls quickly while Maya is working, slowly otherwise, and not while the tab is hidden. */
  private schedulePoll ( delay: number ): void {
    if ( this.destroyed || !this.isSignedIn ) return;
    if ( this.pollTimer ) clearTimeout( this.pollTimer );
    this.pollTimer = setTimeout( () => {
      if ( typeof document !== 'undefined' && document.hidden ) {
        this.schedulePoll( delay );
        return;
      }
      void this.refresh();
    }, delay );
  }
}
