import { Component } from '@angular/core';

/**
 * Explicitly not standalone. The flag is written down, so it must be honoured
 * whatever the version default is — the case that proves the indexer reads the
 * decorator and does not simply apply the era's default to everything.
 */
@Component({
  selector: 'app-legacy-panel',
  standalone: false,
  template: '<div class="panel"></div>',
})
export class LegacyPanelComponent {}
