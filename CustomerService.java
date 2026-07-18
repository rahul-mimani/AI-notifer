package com.example.cdu.service;

import org.springframework.stereotype.Service;
import org.springframework.beans.factory.annotation.Autowired;

@Service
public class CustomerService {
    
    @Autowired
    private CustomerRepository repository;
    
    public CustomerResponse getById(String id) {
        return repository.findById(id);
    }
    
    public void updatePhone(String id, String phone) {
    }
}



package com.example.pou;

import com.example.cdu.service.CustomerService;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

@Service
public class PouService {
    
    @Autowired
    private CustomerService customerService;
    
    public void doWork(String id) {
        CustomerResponse resp = customerService.getById(id);
        customerService.updatePhone(id, "123");
    }
}