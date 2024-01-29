import { Component, OnInit } from '@angular/core';
import { FormBuilder, FormGroup, Validators } from '@angular/forms';
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
  securePass: boolean = true;

  mnemonicForm: FormGroup = new FormGroup({});
  password: string = '';
  confirmPassword: string = '';
  jsonFile: any = null;
  filePath: string = '';

  constructor(
    private authService: AuthService,
    private toasterService: ToastrService,
    private loadingService: LoadingService,
    private fb: FormBuilder,
  ) {}

  ngOnInit() { }

  async loginWithJsonFile() {
    // this.loadingService.isLoading = true;
    // const password = this.password;
    // const key = this.jsonFile;
    // await this.authService.loginFromKeyFile(key, password);
    // this.loadingService.isLoading = false;
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
    // const password = this.password;
    // await this.authService.register(password);
  }

  selectTab(index: number) {
    if (index !== 1 && index !== 2 && index !== 3 && index !== 4) return;
    if (index === 3) this.buildMnemonicsForm();
    this._resetFields();
    this.activeTab = index;
  }

  private _resetFields() {
    this.password = '';
    this.confirmPassword = '';
    this.jsonFile = null;
    this.filePath = '';
  }

  ImportWords() {
    // const mnemonicWords = Object.values(this.mnemonicForm.value) as string[];
    // this.authService.loginWithMnemonics(mnemonicWords, this.password);
  }

  buildMnemonicsForm() {
    const mnemObj: any = {};
    new Array(this.mnemonicsLength).fill("")
      .forEach((q, i) => mnemObj["word" + i] = ['', Validators.required]);
    this.mnemonicForm = this.fb.group(mnemObj);
  }

  get mnemonics() {
    return Object.keys(this.mnemonicForm.value);
  }
}
