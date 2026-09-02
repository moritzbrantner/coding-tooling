pub fn backend_value() -> u8 {
    2
}

#[cfg(test)]
mod tests {
    #[test]
    fn backend_is_reachable() {
        assert_eq!(super::backend_value(), 2);
    }
}
