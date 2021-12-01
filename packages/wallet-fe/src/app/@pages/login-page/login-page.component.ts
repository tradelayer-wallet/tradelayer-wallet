import { Component, OnInit } from '@angular/core';
import { FormBuilder, FormGroup, Validators } from '@angular/forms';
import { ToastrService } from 'ngx-toastr';
import { AuthService } from 'src/app/@core/services/auth.service';
import { RpcService } from 'src/app/@core/services/rpc.service';

@Component({
  selector: 'tl-login-page',
  templateUrl: './login-page.component.html',
  styleUrls: ['./login-page.component.scss']
})
export class LoginPageComponent implements OnInit {

  private jsonFromFile: any = null;

  public loginFormPrivKey: FormGroup = new FormGroup({});
  public loginFormFile: FormGroup = new FormGroup({});
  public registerForm: FormGroup = new FormGroup({});

  constructor(
    private fb: FormBuilder,
    private toasterService: ToastrService,
    private authService: AuthService,
    private rpcService: RpcService,
  ) {}

  get onlineButNotSynced() {
    return !this.rpcService.isSynced && !this.rpcService.isOffline;
  }

  ngOnInit() {
    this._buildForms();
  }

  private _buildForms() {
    this.loginFormPrivKey = this.fb.group({
      privKey: this.fb.control('', [Validators.required]),
      password: this.fb.control('', [Validators.required, Validators.minLength(6)]),
      confirmPass: this.fb.control('', [Validators.required]),
    }, { validator: this.matchPasswords('password', 'confirmPass') });

    this.loginFormFile = this.fb.group({
      jsonFile: this.fb.control(null),
      password: this.fb.control('', [Validators.required, Validators.minLength(6)]),
    });
    
    this.registerForm = this.fb.group({
      password: this.fb.control('', [Validators.required, Validators.minLength(6)]),
      confirmPass: this.fb.control('', [Validators.required]),
    }, { validator: this.matchPasswords('password', 'confirmPass') });
  }

  loginWithPrivKey() {
    const password = this.loginFormPrivKey.value.password;
    const privKey = this.loginFormPrivKey.value.privKey;

    this.authService.loginFromPrivKey(privKey, password);
  }

  loginWithJsonFile() {
    const password = this.loginFormFile.value.password;
    const key = this.jsonFromFile;
    this.authService.loginFromKeyFile(key, password);
  }

  register() {
    const password = this.registerForm.value.password;
    this.authService.register(password);
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
            this.jsonFromFile = json;
            this.loginFormFile.controls.jsonFile.setValue(URI);
          } catch (error) {
            this.jsonFromFile = null;
            this.toasterService.error('Error with accepting the file', 'File Error');
            this.loginFormFile.controls.jsonFile.setValue(null);
          }
        }
      };
  }

  private matchPasswords(controlName1: string, controlName2: string) {
    return (fg: FormGroup) => {
      const control1 = fg.controls[controlName1];
      const control2 = fg.controls[controlName2];
      if (control2.errors && !control2.errors.mustMatch) return;
      control1.value !== control2.value
        ? control2.setErrors({ mustMatch: true })
        : control2.setErrors(null);
    }
  }
}
