import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';

const routes: Routes = [
  {
    path: 'greeting',
    loadChildren: () =>
      import('./features/greeting/greeting.module').then((m) => m.GreetingModule),
  },
  { path: '', redirectTo: 'greeting', pathMatch: 'full' },
];

@NgModule({
  imports: [RouterModule.forRoot(routes)],
  exports: [RouterModule]
})
export class AppRoutingModule { }
