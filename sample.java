package com.example.cdu;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/v1")
public class CustomerController {

    @GetMapping("/customer/{id}")
    public CustomerResponse getCustomer(@PathVariable String id) {
        return null;
    }

    @PostMapping("/customer")
    public CustomerResponse createCustomer(@RequestBody CustomerRequest req) {
        return null;
    }
}