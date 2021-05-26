import { NgModule } from '@angular/core';
import { MatTabsModule } from '@angular/material/tabs';
import { MatFormFieldModule } from '@angular/material/form-field'; 
import { MatInputModule } from '@angular/material/input'; 
import { MatButtonModule } from '@angular/material/button'; 

import { LoginPageComponent } from './login-page/login-page.component';


@NgModule({
    imports: [
        MatTabsModule,
        MatFormFieldModule,
        MatInputModule,
        MatButtonModule,
    ],
    declarations: [
        LoginPageComponent,
    ]
})

export class PagesModule { }
