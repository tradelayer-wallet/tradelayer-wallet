import { Component, OnInit } from '@angular/core';
import { ToastrService } from 'ngx-toastr';
import { AuthService } from 'src/app/@core/services/auth.service';
import { LoadingService } from 'src/app/@core/services/loading.service';

@Component({
  selector: 'tl-login-container',
  templateUrl: './login-container.component.html',
  styleUrls: ['./login-container.component.scss']
})
export class LoginContainerComponent implements OnInit {
  activeTab: 1 | 2 | 3 | 4 = 1;
  mnemonicsLength: number = 12;
  mnemonics: string[] = new Array(this.mnemonicsLength).fill("");
  securePass: boolean = true;

  password: string = '';
  confirmPassword: string = '';
  jsonFile: any = null;
  filePath: string = '';

  constructor(
    private authService: AuthService,
    private toasterService: ToastrService,
    private loadingService: LoadingService,
  ) {}

  ngOnInit() { }

  async loginWithJsonFile() {
    this.loadingService.isLoading = true;
    const password = this.password;
    const key = this.jsonFile;
    await this.authService.loginFromKeyFile(key, password);
    this.loadingService.isLoading = false;
  }

  onFileSelect(event: any, URI: string) {
    const file = event.target.files[0];
    const reader = new FileReader();
    reader.readAsText(file);
    reader.onload = () => {
      if (reader?.result) {
        try {
          const string = reader?.result.toString();
          const json = JSON.parse(string);
          this.jsonFile = json;
          this.filePath = URI;
        } catch (error) {
          this.jsonFile = null;
          this.toasterService.error('Error with accepting the file', 'File Error');
          this.filePath = '';
        }
      }
    };
}

 async register() {
    const password = this.password;
    await this.authService.register(password);
  }

  selectTab(index: number) {
    if (index !== 1 && index !== 2 && index !== 3 && index !== 4) return;
    this._resetFields();
    this.activeTab = index;
  }

  private _resetFields() {
    this.password = '';
    this.confirmPassword = '';
    this.jsonFile = null;
    this.filePath = '';
  }
}
