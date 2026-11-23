/**
 * Work that needs more than marketing is a Mission, and Missions live in
 * Moves (2026-11-23): the Marketing Assistant hands the request to Moves'
 * New Mission page instead of planning it here. Moves' own specs cover the
 * plan reply.
 */
const ME = { uid: 'uid-owner', tenantId: 'tenant-1', paid: true };

describe( 'Missions from the Marketing Assistant go to Moves', () => {
  beforeEach( () => cy.intercept( { url: '**/api/**' }, { statusCode: 200, body: { success: true } } ) );

  it( 'The Marketing Assistant’s work links to planning a Mission in Moves', () => {
    cy.visitWithCypressAuth( '/work', ME );
    cy.get( '[data-cy="work-to-missions"]' ).should( 'have.attr', 'href', 'https://moves.16ahead.com/missions/new' );
  } );

  it( 'old /missions links say Missions live in Moves and open Moves with the request kept', () => {
    cy.visitWithCypressAuth( '/missions?q=Plan%20a%20launch', ME );
    cy.get( '[data-cy="missions-in-moves"]' ).should( 'contain.text', 'Missions live in Moves' );
    cy.get( '[data-cy="missions-open-moves"]' ).should( 'have.attr', 'href', 'https://moves.16ahead.com/missions/new?q=Plan%20a%20launch' );
  } );

  it( 'signed out, the same card shows (Moves asks you to sign in)', () => {
    cy.visit( '/missions' );
    cy.get( '[data-cy="missions-open-moves"]' ).should( 'have.attr', 'href', 'https://moves.16ahead.com/missions/new' );
  } );
} );
