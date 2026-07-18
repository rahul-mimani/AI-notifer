package com.example.pou;

import org.springframework.web.client.RestTemplate;
import org.springframework.stereotype.Service;

@Service
public class CustomerFetcher {
    
    private final RestTemplate restTemplate = new RestTemplate();
    
    public String fetchCustomerPhone(String id) {
        String url = "http://cdu-service/customer/" + id;
        CustomerResponse response = restTemplate.getForObject(url, CustomerResponse.class);
        return response.phone;
    }
    
    public void createCustomer(CustomerRequest req) {
        restTemplate.postForObject("http://cdu-service/customer", req, CustomerResponse.class);
    }
}