import { HttpClient } from "@angular/common/http";
import { Injectable } from "@angular/core";
import { Observable } from "rxjs";
import { environment } from "src/environments/environment";

@Injectable({
  providedIn: 'root',
})
export class ExplorerApiService {
  constructor(private http: HttpClient) {}

  private get apiUrl() {
    return environment.homeApiUrl + '/explorer/api/';
  }

  overview(): Observable<any> {
    return this.http.get(this.apiUrl + 'overview');
  }

  address(address: string): Observable<any> {
    return this.http.get(this.apiUrl + 'address/' + encodeURIComponent(address));
  }

  property(propertyId: string | number): Observable<any> {
    return this.http.get(this.apiUrl + 'property/' + encodeURIComponent(String(propertyId)));
  }

  tx(txid: string): Observable<any> {
    return this.http.get(this.apiUrl + 'tx/' + encodeURIComponent(txid));
  }

  decodeBitvmTx(txid: string): Observable<any> {
    return this.http.get(this.apiUrl + 'tx/' + encodeURIComponent(txid) + '/bitvm');
  }

  report(): Observable<any> {
    return this.http.get(this.apiUrl + 'bitvm/report');
  }

  artifacts(): Observable<any> {
    return this.http.get(this.apiUrl + 'artifacts');
  }

  artifact(name: string): Observable<any> {
    return this.http.get(this.apiUrl + 'artifact/' + encodeURIComponent(name));
  }

  addressHistory(address: string): Observable<any> {
    return this.http.get(this.apiUrl + 'address/' + encodeURIComponent(address) + '/history');
  }

  contractHistory(contractId: string | number): Observable<any> {
    return this.http.get(this.apiUrl + 'contract/' + encodeURIComponent(String(contractId)) + '/history');
  }
}
